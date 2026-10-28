import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DbTransport, DbTransportTerminationInfo } from '../DbTransport.js';

const injected = vi.hoisted(() => ({
  transports: [] as DbTransport[],
  raw: undefined as unknown,
}));
vi.mock('../../index.js', () => ({
  getRawDb: () => injected.raw,
  getDrizzle: vi.fn(),
  ensureReady: vi.fn(),
}));
vi.mock('../WorkerThreadTransport.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../WorkerThreadTransport.js')>();
  return {
    ...original,
    WorkerThreadTransport: class {
      constructor(opts: ConstructorParameters<typeof original.WorkerThreadTransport>[0]) {
        return injected.transports.shift() ?? new original.WorkerThreadTransport(opts);
      }
    },
  };
});

import { createDbClient, createInprocDbClient } from '../DbClient.js';

// Revision regression (unit): public clients must detect same-size/ABA DML and
// connection replacement. Prior query/exec tests had no witness coverage; minimal
// failures are one UPDATE or a restart with identical counters. Native fixtures
// are isolated memory/temp databases; injected transports control the await race.
describe('DbClient', () => {
  it('runs query/exec and disposes idempotently with the inline worker contract', async () => {
    const client = await createDbClient({ useInlineWorker: true });
    try {
      await client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)');
      const inserted = await client.exec('INSERT INTO t (name) VALUES (?)', ['alice']);
      expect(inserted.changes).toBe(1);

      const rows = await client.query<{ id: number; name: string }>(
        'SELECT id, name FROM t WHERE name = ?',
        ['alice'],
      );
      expect(rows).toEqual([{ id: 1, name: 'alice' }]);

      const row = await client.queryOne<{ id: number; name: string }>(
        'SELECT id, name FROM t WHERE id = ?',
        [1],
      );
      expect(row).toEqual({ id: 1, name: 'alice' });
    } finally {
      await client.dispose();
      await client.dispose();
    }
  });

  it('keeps unchanged reads stable and detects same-length edits, ABA, rewind and clear in a real worker', async () => {
    const client = await createDbClient({ useInlineWorker: true });
    try {
      await client.exec('CREATE TABLE history (content TEXT, rewind_at INTEGER)');
      await client.exec("INSERT INTO history VALUES ('abc', NULL)");
      const before = await client.readHistoryRevision!();
      expect(await client.readHistoryRevision!()).toBe(before);
      await client.exec("UPDATE history SET content = 'xyz'");
      const edited = await client.readHistoryRevision!();
      expect(edited).not.toBe(before);
      await client.exec("UPDATE history SET content = 'abc'");
      const restored = await client.readHistoryRevision!();
      expect(restored).not.toBe(before);
      expect(restored).not.toBe(edited);
      await client.exec("UPDATE history SET content = 'xyz'");
      await client.exec("UPDATE history SET content = 'abc'");
      const aba = await client.readHistoryRevision!();
      expect(aba).not.toBe(restored);
      await client.exec('UPDATE history SET rewind_at = 1');
      const rewound = await client.readHistoryRevision!();
      expect(rewound).not.toBe(aba);
      await client.exec('DELETE FROM history');
      const cleared = await client.readHistoryRevision!();
      expect(cleared).not.toBe(rewound);
      await client.exec('VACUUM');
      const vacuumed = await client.readHistoryRevision!();
      expect(vacuumed).not.toBe(cleared);
      await client.exec('CREATE INDEX history_content ON history(content)');
      expect(await client.readHistoryRevision!()).not.toBe(vacuumed);
    } finally {
      await client.dispose();
    }
  });

  it('detects external commits and raw connection replacement with colliding counters inproc', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'db-client-revision-'));
    const dbPath = path.join(dir, 'history.sqlite');
    const db = new Database(dbPath);
    const writer = new Database(dbPath);
    const replacement = new Database(':memory:');
    injected.raw = db;
    try {
      const client = await createInprocDbClient();
      await client.exec('CREATE TABLE history (content TEXT)');
      await client.exec("INSERT INTO history VALUES ('abc')");
      const before = await client.readHistoryRevision!();
      expect(await client.readHistoryRevision!()).toBe(before);
      const ownChanges = db.prepare('SELECT total_changes() AS n').get();
      writer.prepare("UPDATE history SET content = 'xyz'").run();
      expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(ownChanges);
      expect(await client.readHistoryRevision!()).not.toBe(before);
      injected.raw = replacement;
      const fresh = await client.readHistoryRevision!();
      const another = new Database(':memory:');
      try {
        const countersSql =
          'SELECT total_changes() AS changes, data_version AS version FROM pragma_data_version';
        expect(another.prepare(countersSql).get()).toEqual(replacement.prepare(countersSql).get());
        injected.raw = another;
        expect(await client.readHistoryRevision!()).not.toBe(fresh);
      } finally {
        another.close();
      }
    } finally {
      injected.raw = undefined;
      db.close();
      writer.close();
      replacement.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects an in-flight read across restart and gives the new transport a fresh witness', async () => {
    let terminate!: (info: DbTransportTerminationInfo) => void;
    let resolve!: (row: unknown) => void;
    const row = { changes: 0, version: 1, schemaVersion: 0 };
    const old: DbTransport = {
      send: vi.fn().mockResolvedValueOnce(row).mockImplementationOnce(() =>
        new Promise((done) => { resolve = done; })),
      on: vi.fn(),
      onTerminated: (cb) => { terminate = cb; },
      close: vi.fn().mockResolvedValue(undefined),
    };
    const next: DbTransport = {
      send: vi.fn().mockResolvedValue(row), on: vi.fn(), onTerminated: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
    };
    injected.transports.push(old, next);
    const client = await createDbClient();
    try {
      const before = await client.readHistoryRevision!();
      const pending = client.readHistoryRevision!();
      terminate({ code: 1, signal: null });
      resolve(row);
      await expect(pending).rejects.toMatchObject({ code: 'HISTORY_CHANGED' });
      const after = await client.readHistoryRevision!();
      expect(after).not.toBe(before);
      expect(await client.readHistoryRevision!()).toBe(after);
    } finally {
      injected.transports.length = 0;
      await client.dispose();
    }
  });

  it.each([undefined, {}, { changes: '0', version: 1 }, { changes: 0, version: NaN },
    { changes: Number.MAX_SAFE_INTEGER + 1, version: 1 }, { changes: 0, version: -1 }])(
    'fails closed for unsupported or unsafe counters: %j', async (row) => {
      injected.transports.push({
        send: vi.fn().mockResolvedValue(row), on: vi.fn(), onTerminated: vi.fn(),
        close: vi.fn().mockResolvedValue(undefined),
      });
      const client = await createDbClient();
      try {
        await expect(client.readHistoryRevision!()).rejects.toMatchObject({
          code: 'HISTORY_REVISION_UNAVAILABLE',
        });
      } finally {
        await client.dispose();
      }
    },
  );

  it('falls back to worker-thread when utility-process is requested', async () => {
    const client = await createDbClient({ transport: 'utility-process', useInlineWorker: true });
    try {
      // Should not throw — utility-process falls back to worker-thread
      await client.exec('CREATE TABLE fallback_test (id INTEGER PRIMARY KEY)');
      const rows = await client.query<{ id: number }>('SELECT id FROM fallback_test');
      expect(rows).toEqual([]);
    } finally {
      await client.dispose();
    }
  });

  it('falls back to worker-thread when XDT_DB_TRANSPORT=utility-process', async () => {
    const previous = process.env.XDT_DB_TRANSPORT;
    process.env.XDT_DB_TRANSPORT = 'utility-process';
    try {
      const client = await createDbClient({ useInlineWorker: true });
      try {
        await client.exec('CREATE TABLE env_fallback_test (id INTEGER PRIMARY KEY)');
        const rows = await client.query<{ id: number }>('SELECT id FROM env_fallback_test');
        expect(rows).toEqual([]);
      } finally {
        await client.dispose();
      }
    } finally {
      if (previous === undefined) {
        delete process.env.XDT_DB_TRANSPORT;
      } else {
        process.env.XDT_DB_TRANSPORT = previous;
      }
    }
  });
});
