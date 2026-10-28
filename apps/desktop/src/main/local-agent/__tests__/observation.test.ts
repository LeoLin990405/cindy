import { describe, expect, it, vi } from 'vitest';
import { createLocalAgentObservation, LocalAgentObservationError, type ObservationDeps } from '../observation.js';
import { createLocalAgentObservationHost } from '../observationHost.js';
import { remoteInvoke } from '../../device-link/index.js';
import { handleListDevices } from '../../device-link/ipc.js';
import type { Maker } from '@cindy/maker-core';
import { ipcMain } from 'electron';
import { DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';
import { registerRemoteHistoryIpc } from '../../localDb/ipc/history.js';
import { listSessionsForHistory, getMessagesForHistory } from '../../localDb/chatHistoryReader.js';
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: vi.fn() }));
vi.mock('../../localDb/sessionTerminal.js', () => ({ readLatestSessionTerminal: vi.fn() }));
vi.mock('../../device-link/index.js', () => ({ remoteInvoke: vi.fn() }));
vi.mock('../../device-link/ipc.js', () => ({ handleListDevices: vi.fn(), defaultDeps: () => ({}) }));
vi.mock('../../localDb/chatHistoryReader.js', () => ({ listSessionsForHistory: vi.fn(), getMessagesForHistory: vi.fn() }));
vi.mock('../../device-link/broadcast-tap.js', () => ({ captureDataOwnerBroadcastScope: vi.fn(), isDataOwnerBroadcastScopeCurrent: () => true }));
vi.mock('../../authManager.js', () => ({ getDeviceId: () => 'self' }));
vi.mock('../../deepLink.js', () => ({ buildHistorySessionDeepLink: vi.fn() }));
const sourceToken = Buffer.from(JSON.stringify({ c: 1, i: 's::opaque' })).toString('base64url');

/* Test value: public read entry protects bounded read-only observation, source-local identity,
 * cursor integrity, visibility and revocation (local-agent API + remote/security rules).
 * Existing history tests do not cover this grant-facing adapter. Minimal failures: a changed
 * cursor/device, one hidden row, one revoked await, or a legacy empty runtime. Unit tier,
 * entirely injected memory snapshots; elapsed time reported with delivery. */
const devices = [
  { deviceId: 'local', deviceName: 'Local', local: true, available: true },
  { deviceId: 'remote', deviceName: 'Remote', local: false, available: true },
  { deviceId: 'offline', deviceName: 'Offline', local: false, available: false, unavailableReason: 'REMOTE_DEVICE_OFFLINE' },
  { deviceId: 'disabled', deviceName: 'Disabled', local: false, available: false, unavailableReason: 'REMOTE_DISABLED' },
];
const empty = { items: [], nextCursor: null, hasMore: false };
function setup(overrides: Partial<ObservationDeps> = {}) {
  const deps: ObservationDeps = {
    listDevices: vi.fn(async () => devices), sessions: vi.fn(async () => empty),
    history: vi.fn(async () => empty), runtime: vi.fn(async () => ({ format: 'active-sessions-v2', sessions: [] })),
    ...overrides,
  };
  return { deps, reader: createLocalAgentObservation(deps) };
}
const current = () => {};
const row = (id: string, role = 'assistant', content: unknown = 'hello') => ({ id, role, content, rewindAt: null,
  createdAt: 1, agentMeta: { secret: 'hidden' }, toolParams: 'hidden', sessionId: 'untrusted' });

describe('local agent observation read', () => {
  it('paginates the live authorized device directory with bounded, reusable continuations', async () => {
    let directory = devices;
    const { reader } = setup({ listDevices: async () => directory });
    const first = await reader.read('observation/devices', { limit: 1 }, current) as any;
    expect(first.devices.map((d: any) => d.deviceId)).toEqual(['disabled']);
    expect(first).toMatchObject({ hasMore: true, consistency: 'live' });
    directory = [...devices, { deviceId: 'new', deviceName: 'New', local: false, available: true }];
    const second = await reader.read('observation/devices', { limit: 2, cursor: first.nextCursor }, current) as any;
    expect(second.devices.map((d: any) => d.deviceId)).toEqual(['local', 'new']);
    const last = await reader.read('observation/devices', { limit: 100, cursor: second.nextCursor }, current) as any;
    expect(last.devices.map((d: any) => d.deviceId)).toEqual(['offline', 'remote']);
    expect(last).toMatchObject({ nextCursor: null, hasMore: false });
    await expect(reader.read('observation/devices', { cursor: 'broken' }, current)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(reader.read('observation/sessions', { cursor: first.nextCursor }, current)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(reader.read('observation/devices', { limit: 101 }, current)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
  });
  it('enforces the serialized response budget and lets the same cursor retry a smaller page', async () => {
    const { reader } = setup({ sessions: async (_device, args) => ({
      items: Array.from({ length: args.limit }, (_, n) => ({ id: `s${n}`, title: '\u0000'.repeat(512) })),
      nextCursor: { createdAt: 1, id: 's' }, hasMore: true,
    }) });
    const first = await reader.read('observation/sessions', { limit: 1 }, current) as any;
    await expect(reader.read('observation/sessions', { limit: 100, cursor: first.nextCursor }, current))
      .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    const retry = await reader.read('observation/sessions', { limit: 1, cursor: first.nextCursor }, current) as any;
    expect(retry.sessions).toHaveLength(1);
  });

  it('rejects delivery when the exact remote target was disabled or revoked during a read', async () => {
    for (const revoked of [false, true]) {
      let finished = false;
      const { reader } = setup({
        listDevices: async () => finished ? revoked ? [] : [{ ...devices[1], available: false, unavailableReason: 'REMOTE_DISABLED' }] : devices,
        sessions: async () => { finished = true; return empty; },
      });
      await expect(reader.read('observation/sessions', { deviceId: 'remote' }, current)).rejects.toMatchObject({
        code: revoked ? 'REMOTE_ACCESS_REVOKED' : 'REMOTE_DISABLED',
      });
    }
  });

  it('reads real host remote helper payloads, source cursors, ISO timestamps and owner links', async () => {
    vi.mocked(handleListDevices).mockResolvedValue({ devices: [{ deviceId: 'remote', name: 'Remote',
      isSelf: false, online: true, controlEnabled: true, remoteControlEnabled: true, platform: 'macos' } as any] });
    vi.mocked(remoteInvoke).mockResolvedValue({ ok: true, result: { ok: true,
      sessions: [{ id: 's::opaque', title: 'Remote title', createdAt: '2026-01-01T00:00:00.000Z',
        sessionUrl: 'cindy://session/s%3A%3Aopaque?device=remote', model: 'secret' }],
      nextCursor: sourceToken, hasMore: true } });
    const host = createLocalAgentObservationHost({ listActiveSessions: () => [] } as unknown as Maker, () => current);
    const first = await host.read('observation/sessions', { deviceId: 'remote', limit: 2 }, current) as any;
    expect(first.sessions).toEqual([{ sessionId: 's::opaque', title: 'Remote title',
      createdAt: '2026-01-01T00:00:00.000Z', sessionUrl: 'cindy://session/s%3A%3Aopaque?device=remote' }]);
    await host.read('observation/sessions', { deviceId: 'remote', limit: 1, cursor: first.nextCursor }, current);
    expect(vi.mocked(remoteInvoke).mock.calls.at(-1)?.[2]).toEqual([{ tool: 'list_sessions', args: {
      device: 'local', limit: 1, order: 'desc', cursor: sourceToken,
    } }]);
    const preSend = vi.mocked(remoteInvoke).mock.calls.at(-1)?.[3]?.preSend;
    expect(preSend).toBeTypeOf('function');
    vi.mocked(remoteInvoke).mockResolvedValue({ ok: true, result: { ok: true, sessions: [], hasMore: true, nextCursor: 'broken' } });
    await expect(host.read('observation/sessions', { deviceId: 'remote' }, current)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    vi.mocked(remoteInvoke).mockResolvedValue({ ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'private detail' } });
    await expect(host.read('observation/sessions', { deviceId: 'remote' }, current)).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' });
    vi.mocked(remoteInvoke).mockImplementation(async (_id, _channel, _args, options) => {
      options?.preSend?.();
      return { ok: true, result: { ok: false, errorCode: 'private detail' } };
    });
    await expect(host.read('observation/sessions', { deviceId: 'remote' }, current)).rejects.toMatchObject({ code: 'REMOTE_INVALID_RESPONSE' });
  });
  it('filters typed private content and hidden inputs through the real remote history handler before delivery', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => { handlers.set(channel, handler); });
    let oversized = false;
    registerRemoteHistoryIpc({
      sessionExists: async id => id === 's::opaque',
      getMessages: async () => ({ ...empty, items: oversized ? [row('large', 'assistant', 'x'.repeat(1024 * 1024))] : [
        row('thinking', 'assistant', { type: 'thinking', text: 'private thinking' }),
        row('tool', 'assistant', { type: 'tool_use', content: 'private tool' }),
        row('trigger', 'user', '[UI_ACTION_TRIGGER]'.concat('private trigger'.repeat(800))),
        { ...row('resume', 'user', 'private continuation'), agentMeta: { autoResume: true } },
        row('answer', 'assistant', [{ type: 'text', text: 'visible answer' }, { type: 'thinking', text: 'private block' }]),
      ] }) as any,
      readTerminal: async () => undefined,
    });
    vi.mocked(handleListDevices).mockResolvedValue({ devices: [{ deviceId: 'remote', name: 'Remote',
      isSelf: false, online: true, controlEnabled: true, remoteControlEnabled: true, platform: 'macos' } as any] });
    let request: any;
    vi.mocked(remoteInvoke).mockImplementation(async (id, channel, values, options) => {
      expect(id).toBe('remote');
      options?.preSend?.();
      if (channel === 'local-db:sessions:get') {
        expect(values).toEqual(['s::opaque']);
        return { ok: true, result: { id: 's::opaque', status: 'active' } };
      }
      expect(channel).toBe(DL_HISTORY_MESSAGES_CHANNEL);
      request = values[0];
      return { ok: true, result: await handlers.get(channel)!({}, request) };
    });
    const host = createLocalAgentObservationHost({ listActiveSessions: () => [] } as unknown as Maker, () => current);
    const result = await host.read('observation/history', { deviceId: 'remote', sessionId: 's::opaque' }, current) as any;
    expect(request).toMatchObject({ sessionId: 's::opaque', contentCharLimit: null, limit: 50, includeRewound: false });
    expect(result.messages.map((m: any) => m.id)).toEqual(['thinking', 'tool', 'answer']);
    expect(result.messages.map((m: any) => m.text)).toEqual(['', '', 'visible answer']);
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
    oversized = true;
    await expect(host.read('observation/history', { deviceId: 'remote', sessionId: 's::opaque' }, current))
      .rejects.toMatchObject({ code: 'REMOTE_PAYLOAD_TOO_LARGE' });

    const { reader } = setup({ readLocalQueue: () => [{ queuedMessageId: 'q', position: 0, source: 'user',
      sourceLabel: null, enqueuedAtMs: 1, consuming: false, content: '[UI_ACTION_TRIGGER]private queue' }] });
    const queue = await reader.read('observation/inspect', { sessionIds: ['s'] }, current) as any;
    expect(queue.sessions[0].queue).toMatchObject({ count: 1, items: [{ content: '', hidden: true, truncated: true }] });
    expect(JSON.stringify(queue)).not.toContain('private');
  });

  /* PR7696 P1: cached explicit IDs bypassed tombstone visibility in the real host.
   * Existing pure reader tests cannot detect that DB join behavior. Minimal input: one
   * deleted ID, or deletion while history/runtime is pending. Public host/IPC unit tier;
   * memory sources only, including the real remote history handler above. */
  it.each(['local', 'remote'])('gates %s history and queue inspection before and after pending reads', async deviceId => {
    for (const method of ['observation/history', 'observation/inspect'] as const) {
      for (const deletedBefore of [true, false]) {
        let deleted = deletedBefore;
        let release!: () => void;
        let entered!: () => void;
        const pending = new Promise<void>(resolve => { release = resolve; });
        const started = new Promise<void>(resolve => { entered = resolve; });
        const read = vi.fn(async () => { entered(); await pending; return empty; });
        const queue = vi.fn(() => [{ queuedMessageId: 'q', position: 0, source: 'user' as const,
          sourceLabel: null, enqueuedAtMs: 1, consuming: false, content: 'private cached queue' }]);
        const active = vi.fn(() => { entered(); return []; });
        vi.mocked(listSessionsForHistory).mockImplementation(async args => {
          expect(args).toEqual({ sessionIds: ['s::opaque'], includeDeleted: false, workdir: null,
            fromMs: null, toMs: null, agentKind: null, cursor: null, order: 'desc', limit: 1 });
          // Hold the local post-runtime metadata check to model deletion before delivery.
          if (method === 'observation/inspect' && active.mock.calls.length) await pending;
          return { ...empty, items: deleted ? [] : [{ id: 's::opaque', status: 'active' } as any] };
        });
        vi.mocked(getMessagesForHistory).mockImplementation(read);
        vi.mocked(handleListDevices).mockResolvedValue({ devices: [{ deviceId: 'remote', name: 'Remote',
          isSelf: false, online: true, controlEnabled: true, remoteControlEnabled: true, platform: 'macos' } as any] });
        vi.mocked(remoteInvoke).mockImplementation(async (_id, channel, args, options) => {
          options?.preSend?.();
          if (channel === 'local-db:sessions:get') {
            expect(args).toEqual(['s::opaque']);
            return { ok: true, result: { id: 's::opaque', status: deleted ? 'deleted' : 'active' } };
          }
          await read();
          return { ok: true, result: channel === DL_HISTORY_MESSAGES_CHANNEL ? empty : { format: 'active-sessions-v2', sessions: [] } };
        });
        const host = createLocalAgentObservationHost({ listActiveSessions: active } as unknown as Maker, () => current, queue);
        const result = host.read(method, { deviceId, ...(method === 'observation/history'
          ? { sessionId: 's::opaque' } : { sessionIds: ['s::opaque'] }) }, current);
        const rejected = expect(result).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'NOT_FOUND' });
        if (!deletedBefore) {
          await started;
          deleted = true;
          release();
        }
        await rejected;
        expect(queue).not.toHaveBeenCalled();
        if (deletedBefore) {
          expect(read).not.toHaveBeenCalled();
          expect(active).not.toHaveBeenCalled();
        }
      }
    }
  });

  it('rejects absent, mismatched and malformed remote target metadata before reading', async () => {
    for (const metadata of [null, { id: 'other', status: 'active' }, { id: 's' },
      { id: 's', status: {} }, { id: 's', status: 'unknown' }]) {
      const history = vi.fn();
      vi.mocked(remoteInvoke).mockImplementation(async (_id, channel) => {
        if (channel !== 'local-db:sessions:get') history();
        return { ok: true, result: metadata };
      });
      const host = createLocalAgentObservationHost({ listActiveSessions: () => [] } as unknown as Maker, () => current);
      await expect(host.read('observation/history', { deviceId: 'remote', sessionId: 's' }, current))
        .rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(history).not.toHaveBeenCalled();
    }
  });

  it('preserves source rowid cursors and binds page tokens to every query dimension', async () => {
    const source = { createdAt: 1, id: 'z', rowid: 42 };
    const history = vi.fn<ObservationDeps['history']>(async () => ({ items: [row('z')], nextCursor: source, hasMore: true }));
    const { reader } = setup({ history });
    const first = await reader.read('observation/history', { deviceId: 'remote', sessionId: 'opaque::id', limit: 1 }, current) as any;
    const second = await reader.read('observation/history', { deviceId: 'remote', sessionId: 'opaque::id', limit: 1, cursor: first.nextCursor }, current) as any;
    expect(second.messages[0]).toMatchObject({ id: 'z', sessionId: 'opaque::id', text: 'hello' });
    expect(history.mock.calls[1][2].cursor).toEqual(source);
    for (const changed of [{ deviceId: 'local' }, { sessionId: 'other' }, { order: 'asc' }, { workdir: 'path' }]) {
      await expect(reader.read('observation/history', { deviceId: 'remote', sessionId: 'opaque::id', limit: 1,
        cursor: first.nextCursor, ...changed }, current)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    }
    await reader.read('observation/history', { deviceId: 'remote', sessionId: 'opaque::id', limit: 2, cursor: first.nextCursor }, current);
    expect(history.mock.calls[2][2]).toMatchObject({ limit: 2, cursor: source });
    for (const cursor of ['garbage', '', first.nextCursor.replace(/^./, first.nextCursor[0] === 'a' ? 'b' : 'a')]) {
      await expect(reader.read('observation/history', { sessionId: 's', cursor }, current)).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    }
  });

  it('keeps remote source cursors intact and exposes only session allowlisted fields', async () => {
    const sessions = vi.fn<ObservationDeps['sessions']>(async () => ({ items: [{ id: 's::opaque', title: 'Title', agentMeta: 'hidden', model: 'hidden', sessionUrl: 'https://untrusted.example/' }],
      hasMore: true, nextCursor: sourceToken }));
    const { reader } = setup({ sessions });
    const first = await reader.read('observation/sessions', { deviceId: 'remote' }, current) as any;
    expect(first.sessions).toEqual([{ sessionId: 's::opaque', title: 'Title' }]);
    await reader.read('observation/sessions', { deviceId: 'remote', cursor: first.nextCursor }, current);
    expect(sessions.mock.calls[1][1]).toMatchObject({ cursor: sourceToken, limit: 50, includeDeleted: false });
  });

  it('filters hidden and rewound messages, never stringifies tool blocks, and bounds total text', async () => {
    const { reader } = setup({ history: async () => ({ ...empty, items: [row('tool', 'tool_result'),
      { ...row('rewound'), rewindAt: 2 }, row('u', 'user', [{ type: 'tool_use', text: 'hidden' }, { type: 'text', text: 'visible' }]),
      row('ask', 'ask_user', { text: 'question', params: 'hidden' }), row('plan', 'plan_review', 'plan'),
      row('a', 'assistant', 'a'.repeat(10000)), row('b', 'assistant', 'b'.repeat(10000))] }) });
    const result = await reader.read('observation/history', { sessionId: 's::local' }, current) as any;
    expect(result.messages.map((m: any) => m.id)).toEqual(['u', 'ask', 'plan', 'a', 'b']);
    expect(result.messages[0].text).toBe('visible');
    expect(result.messages.every((m: any) => m.text.length <= 8000)).toBe(true);
    expect(result.messages.reduce((n: number, m: any) => n + m.text.length, 0)).toBeLessThanOrEqual(12000);
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain('hidden');
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(131072);
  });

  it('preserves upstream and structured truncation without exposing typed thinking or tool objects', async () => {
    // Remote IPC already caps text and records provenance before this public read layer.
    const { reader } = setup({ history: async () => ({ ...empty, items: [
      { ...row('remote', 'assistant', 'a'.repeat(8000)), agentMeta: { remoteContentTruncated: true, secret: 'private' } },
      row('blocks', 'assistant', Array.from({ length: 129 }, () => ({ type: 'text', text: 'x' }))),
      row('thinking', 'assistant', { type: 'thinking', text: 'private thinking' }),
      row('tool', 'assistant', { type: 'tool_use', content: 'private tool' }),
      row('media', 'user', { text: 'See attachment', images: [{ url: 'private image' }], files: [{ path: 'private file' }] }),
    ] }) });
    const result = await reader.read('observation/history', { deviceId: 'remote', sessionId: 's' }, current) as any;
    expect(result.messages.map((m: any) => m.truncated)).toEqual([true, true, true, true, true]);
    expect(result.messages.map((m: any) => m.text.length)).toEqual([8000, 255, 0, 0, 14]);
    expect(result.partial).toBe(true);
    expect(JSON.stringify(result)).not.toContain('private');
  });

  it.each([
    { items: [], nextCursor: null, hasMore: true },
    { items: 'bad', nextCursor: null, hasMore: false },
    { items: [], nextCursor: { createdAt: 1, id: 's', rowid: 0 }, hasMore: true },
    { items: [{}], nextCursor: null, hasMore: false },
  ])('rejects malformed remote pages instead of restarting pagination: %j', async (page) => {
    const { reader } = setup({ sessions: async () => page });
    await expect(reader.read('observation/sessions', { deviceId: 'remote' }, current)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each([
    ['offline', 'REMOTE_DEVICE_OFFLINE'], ['disabled', 'REMOTE_DISABLED'], ['missing', 'REMOTE_ACCESS_REVOKED'],
  ])('preserves device-specific failure %s', async (deviceId, code) => {
    const { reader, deps } = setup();
    await expect(reader.read('observation/sessions', { deviceId }, current)).rejects.toMatchObject({ code });
    expect(deps.sessions).not.toHaveBeenCalled();
  });

  it('discards late success and failure after account/grant revocation', async () => {
    for (const reject of [false, true]) {
      let valid = true;
      const { reader } = setup({ history: async () => { valid = false; if (reject) throw new Error('private'); return empty; } });
      await expect(reader.read('observation/history', { sessionId: 's' }, () => {
        if (!valid) throw new LocalAgentObservationError('UNAUTHORIZED');
      })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  it('does not equate legacy absence with idle or unavailable queues with zero', async () => {
    const { reader } = setup({ runtime: async () => [{ sessionId: 'running', isTurnRunning: true, capabilities: 'hidden' }],
      readLocalQueue: (id) => id === 'running' ? [] : undefined });
    const result = await reader.read('observation/inspect', { sessionIds: ['running', 'absent'] }, current) as any;
    expect(result.sessions).toEqual([
      { sessionId: 'running', runtime: { state: 'running', authoritative: false }, queue: { status: 'available', count: 0, items: [], truncated: false } },
      { sessionId: 'absent', runtime: { state: 'unknown', authoritative: false }, queue: { status: 'unavailable' } },
    ]);
    const remote = await reader.read('observation/inspect', { deviceId: 'remote', sessionIds: ['absent'] }, current) as any;
    expect(remote.sessions[0].queue).toEqual({ status: 'unsupported' });
    const v2 = await setup().reader.read('observation/inspect', { sessionIds: ['absent'] }, current) as any;
    expect(v2.sessions[0].runtime).toEqual({ state: 'not-active', authoritative: true });
    // Device-link can omit a running background task without changing the v2 envelope.
    const remoteV2 = await setup().reader.read('observation/inspect', { deviceId: 'remote', sessionIds: ['absent'] }, current) as any;
    expect(remoteV2.sessions[0].runtime).toEqual({ state: 'unknown', authoritative: false });
    expect(remoteV2.partial).toBe(true);
  });

  it('projects at most 20 queue entries and 500 characters each without restoring anything', async () => {
    const readLocalQueue = vi.fn(() => Array.from({ length: 21 }, (_, position) => ({ queuedMessageId: `q${position}`,
      position, source: 'user' as const, sourceLabel: null, enqueuedAtMs: 1, content: 'x'.repeat(501), consuming: false,
      secret: 'hidden' })));
    const { reader } = setup({ readLocalQueue });
    const result = await reader.read('observation/inspect', { sessionIds: ['s'] }, current) as any;
    expect(result.sessions[0].queue).toMatchObject({ count: 21, truncated: true });
    expect(result.sessions[0].queue.items).toHaveLength(20);
    expect(result.sessions[0].queue.items[0].content).toHaveLength(500);
    expect(JSON.stringify(result)).not.toContain('hidden');
    expect(result.partial).toBe(true);
  });

  it('rejects unbounded/invalid requests and malformed runtimes; preserves unsupported errors', async () => {
    const { reader } = setup();
    for (const params of [{ limit: 101 }, { limit: 0 }, { limit: 1.5 }, { cursor: null }, { deviceId: 'all' }, { includeRewound: true }]) {
      await expect(reader.read('observation/sessions', params, current)).rejects.toBeInstanceOf(LocalAgentObservationError);
    }
    for (const sessionIds of [[], Array(33).fill('s'), ['s', 's']]) {
      await expect(reader.read('observation/inspect', { sessionIds }, current)).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
    }
    const malformed = setup({ runtime: async () => ({ sessions: [{ sessionId: 's' }] }) }).reader;
    await expect(malformed.read('observation/inspect', { sessionIds: ['s'] }, current)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    const unsupported = setup({ runtime: async () => { throw new LocalAgentObservationError('REMOTE_UNSUPPORTED'); } }).reader;
    await expect(unsupported.read('observation/inspect', { deviceId: 'remote', sessionIds: ['s'] }, current)).rejects.toMatchObject({ code: 'REMOTE_UNSUPPORTED' });
  });
});
