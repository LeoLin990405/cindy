import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { GetMessagesParams, ListSessionsParams } from '../localDb/chatHistoryReader.js';
import type { SessionQueueInspectionEntry } from '../maker-ipc/sessionQueueInspection.js';
import { DEEP_LINK_SCHEMES } from '../../shared/deepLinkSchemes.js';
import { isSyntheticTriggerText } from '@cindy/maker-shared/synthetic-trigger';

export const OBSERVATION_METHODS = Object.freeze([
  'observation/devices', 'observation/sessions', 'observation/history', 'observation/inspect',
] as const);
export type ObservationMethod = typeof OBSERVATION_METHODS[number];
export class LocalAgentObservationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'LocalAgentObservationError'; }
}
export interface LocalAgentObservation {
  read(method: ObservationMethod, params: Record<string, unknown>, assertCurrent: () => void): Promise<unknown>;
}
export interface ObservationDevice {
  deviceId: string; deviceName: string; local: boolean; available: boolean; unavailableReason?: string;
}
export type ObservationSessionsParams = Omit<ListSessionsParams, 'cursor'> & {
  cursor: ListSessionsParams['cursor'] | string;
};
/** Only fixed, already-authorized reads belong here. No generic IPC surface. */
export interface ObservationDeps {
  listDevices(assertCurrent: () => void): Promise<unknown>;
  sessions(deviceId: string, args: ObservationSessionsParams, assertCurrent: () => void): Promise<unknown>;
  history(deviceId: string, sessionId: string, args: GetMessagesParams, assertCurrent: () => void): Promise<unknown>;
  runtime(deviceId: string, sessionIds: string[], assertCurrent: () => void): Promise<unknown>;
  /** Must be a side-effect-free snapshot: never restore queues or dispatch inputs. */
  readLocalQueue?(sessionId: string): readonly SessionQueueInspectionEntry[] | null | undefined;
}
const fail = (code: string): never => { throw new LocalAgentObservationError(code); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
function identifier(value: unknown, code = 'INVALID_PARAMS'): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\x00-\x1f]/.test(value)) return fail(code);
  return value;
}
function sourceCursor(value: unknown): Record<string, unknown> | string | null {
  if (value === null) return null;
  if (typeof value === 'string') {
    if (!value || value.length > 4096 || !/^[\w-]+$/.test(value)) return fail('INVALID_RESPONSE');
    try {
      const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      sourceCursor({ createdAt: c.c, id: c.i, ...(c.r !== undefined ? { rowid: c.r } : {}) });
    } catch { return fail('INVALID_RESPONSE'); }
    return value;
  }
  const c = object(value);
  if (typeof c.createdAt !== 'number' || !Number.isFinite(c.createdAt)
    || typeof c.id !== 'string' || !c.id || c.id.length > 256
    || (c.rowid !== undefined && (!Number.isSafeInteger(c.rowid) || Number(c.rowid) < 1))) return fail('INVALID_RESPONSE');
  return { createdAt: c.createdAt, id: c.id, ...(c.rowid !== undefined ? { rowid: c.rowid } : {}) };
}
function page(value: unknown, limit: number) {
  const p = object(value);
  if (!Array.isArray(p.items) || p.items.length > limit || typeof p.hasMore !== 'boolean') return fail('INVALID_RESPONSE');
  const cursor = sourceCursor(p.nextCursor);
  if (p.hasMore !== (cursor !== null)) return fail('INVALID_RESPONSE');
  return { items: p.items.map(object), hasMore: p.hasMore, cursor };
}
function text(value: unknown): { value: string; incomplete: boolean } {
  if (typeof value === 'string') return { value, incomplete: false };
  if (Array.isArray(value)) {
    let result = '', incomplete = value.length > 128;
    for (const v of value.slice(0, 128)) {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { incomplete = true; continue; }
      const b = v as Record<string, unknown>;
      if (b.type !== 'text' || typeof b.text !== 'string') {
        // Tools/thinking are intentionally outside this view; other blocks may be visible media.
        if (!['thinking', 'redacted_thinking', 'tool_use', 'tool_result'].includes(String(b.type))) incomplete = true;
        continue;
      }
      result += (result ? '\n' : '') + b.text.slice(0, 8001 - result.length);
      if (result.length >= 8001) { incomplete = true; break; }
    }
    return { value: result, incomplete };
  }
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>;
    if (v.type !== undefined && v.type !== 'text') return { value: '', incomplete: true };
    const content = typeof v.text === 'string' ? v.text : typeof v.content === 'string' ? v.content : null;
    const omittedMedia = ['images', 'files', 'attachments'].some((key) =>
      Array.isArray(v[key]) ? v[key].length > 0 : !!v[key]);
    return { value: content ?? '', incomplete: content === null || omittedMedia };
  }
  return { value: '', incomplete: true };
}
function metadata(row: Record<string, unknown>, keys: string[]) {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string') out[key] = v.slice(0, 512);
    else if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
  }
  return out;
}

export function createLocalAgentObservation(deps: ObservationDeps): LocalAgentObservation {
  // In-memory integrity key, not an authorization credential or persistent cursor ledger.
  const key = randomBytes(32);
  const mac = (s: string) => createHmac('sha256', key).update(s).digest();
  const encodeToken = (binding: string, cursor: unknown): string => {
    const body = Buffer.from(JSON.stringify({ binding, cursor })).toString('base64url');
    return `${body}.${mac(body).toString('base64url')}`;
  };
  const decodeToken = (raw: unknown, binding: string): unknown => {
    if (typeof raw !== 'string' || raw.length > 12000 || !/^[\w-]+\.[\w-]+$/.test(raw)) return fail('INVALID_CURSOR');
    const [body, signature] = raw.split('.');
    const bytes = Buffer.from(signature, 'base64url');
    if (bytes.length !== 32 || bytes.toString('base64url') !== signature || !timingSafeEqual(mac(body), bytes)) return fail('INVALID_CURSOR');
    try {
      const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (decoded.binding !== binding) return fail('INVALID_CURSOR');
      return decoded.cursor;
    } catch { return fail('INVALID_CURSOR'); }
  };
  return {
    async read(method, params, assertCurrent) {
      assertCurrent();
      const checked = async <T>(read: () => Promise<T>): Promise<T> => {
        assertCurrent();
        try { const value = await read(); assertCurrent(); return value; }
        catch (error) { assertCurrent(); throw error; }
      };
      const deliver = async (result: Record<string, unknown>) => {
        assertCurrent();
        if (method !== 'observation/devices' && deviceId !== 'local') await assertDeviceEligible();
        if (Buffer.byteLength(JSON.stringify(result)) > 131072) return fail('RESPONSE_TOO_LARGE');
        assertCurrent();
        return result;
      };
      if (!OBSERVATION_METHODS.includes(method)) return fail('METHOD_NOT_FOUND');
      const allowed = method === 'observation/devices' ? ['limit', 'cursor'] : method === 'observation/inspect'
        ? ['deviceId', 'sessionIds'] : ['deviceId', 'sessionId', 'limit', 'cursor', 'order', 'workdir', 'fromMs', 'toMs', 'agentKind'];
      if (Object.keys(params).some((k) => !allowed.includes(k))) return fail('INVALID_PARAMS');
      const deviceId = params.deviceId === undefined ? 'local' : identifier(params.deviceId);
      const loadDevices = async (): Promise<ObservationDevice[]> => {
        const raw = await checked(() => deps.listDevices(assertCurrent));
        if (!Array.isArray(raw) || raw.length > 10000) return fail('INVALID_RESPONSE');
        const devices = raw.map((v): ObservationDevice => {
          const d = object(v);
          const id = identifier(d.deviceId, 'INVALID_RESPONSE');
          if (typeof d.local !== 'boolean' || typeof d.available !== 'boolean' || (d.local !== (id === 'local'))) return fail('INVALID_RESPONSE');
          return { deviceId: id, deviceName: typeof d.deviceName === 'string' ? d.deviceName.slice(0, 256) : '',
            local: d.local, available: d.available,
            ...(!d.available ? { unavailableReason: d.unavailableReason === 'REMOTE_DEVICE_OFFLINE' ? 'REMOTE_DEVICE_OFFLINE' : 'REMOTE_DISABLED' } : {}) };
        });
        if (new Set(devices.map((d) => d.deviceId)).size !== devices.length) return fail('INVALID_RESPONSE');
        return devices;
      };
      if (method === 'observation/devices') {
        const limit = params.limit ?? 50;
        if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) return fail('INVALID_PARAMS');
        const binding = JSON.stringify([method]);
        const after = params.cursor === undefined ? null : identifier(decodeToken(params.cursor, binding), 'INVALID_CURSOR');
        const devices = (await loadDevices()).sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0)
          .filter((d) => after === null || d.deviceId > after);
        const items = devices.slice(0, Number(limit));
        const hasMore = devices.length > Number(limit);
        return deliver({ devices: items, nextCursor: hasMore ? encodeToken(binding, items[items.length - 1].deviceId) : null,
          hasMore, observedAt: Date.now(), partial: false, consistency: 'live' });
      }
      async function assertDeviceEligible() {
        const device = (await loadDevices()).find((d) => d.deviceId === deviceId);
        if (!device) return fail('REMOTE_ACCESS_REVOKED');
        if (!device.available) return fail(device.unavailableReason!);
      }
      if (deviceId !== 'local') await assertDeviceEligible();
      if (method === 'observation/inspect') {
        if (!Array.isArray(params.sessionIds) || !params.sessionIds.length || params.sessionIds.length > 32) return fail('INVALID_PARAMS');
        const ids = params.sessionIds.map((id) => identifier(id));
        if (new Set(ids).size !== ids.length) return fail('INVALID_PARAMS');
        const raw = await checked(() => deps.runtime(deviceId, ids, assertCurrent));
        const v2 = !Array.isArray(raw) && object(raw).format === 'active-sessions-v2';
        const rows = Array.isArray(raw) ? raw : object(raw).sessions;
        if (!Array.isArray(rows) || rows.length > 4096) return fail('INVALID_RESPONSE');
        const runtimes = new Map<string, Record<string, unknown>>();
        for (const value of rows) {
          const r = object(value);
          const id = identifier(r.sessionId, 'INVALID_RESPONSE');
          if (typeof r.isTurnRunning !== 'boolean' || runtimes.has(id)) return fail('INVALID_RESPONSE');
          runtimes.set(id, r);
        }
        let partial = false, queueTextRemaining = 12000;
        const sessions = ids.map((sessionId) => {
          const r = runtimes.get(sessionId);
          // Remote device-link may filter background sessions while retaining the v2 wrapper.
          // Presence is evidence; remote absence cannot certify an inactive runtime.
          const authoritative = v2 && (deviceId === 'local' || !!r);
          const state = r ? (r.isTurnRunning ? 'running' : 'idle') : authoritative ? 'not-active' : 'unknown';
          assertCurrent();
          let entries: readonly SessionQueueInspectionEntry[] | null | undefined;
          const supported = deviceId === 'local' && !!deps.readLocalQueue;
          try { entries = supported ? deps.readLocalQueue!(sessionId) : undefined; } catch { entries = undefined; }
          assertCurrent();
          const items = entries?.slice(0, 20).map((entry) => {
            const hidden = entry.hidden === true || isSyntheticTriggerText(entry.content);
            const content = hidden ? '' : entry.content.slice(0, Math.min(500, queueTextRemaining));
            queueTextRemaining -= content.length;
            return { queuedMessageId: identifier(entry.queuedMessageId, 'INVALID_RESPONSE'), position: entry.position,
              source: entry.source, sourceLabel: entry.sourceLabel?.slice(0, 256) ?? null,
              enqueuedAtMs: entry.enqueuedAtMs, consuming: entry.consuming,
              content, ...(hidden ? { hidden: true } : {}), truncated: hidden || content.length < entry.content.length };
          });
          const truncated = !!entries && (entries.length > 20 || !!items?.some((item) => item.truncated));
          const queue = !supported ? { status: 'unsupported' } : !entries ? { status: 'unavailable' }
            : { status: 'available', count: entries.length, items, truncated };
          partial ||= state === 'unknown' || queue.status !== 'available' || truncated;
          return { sessionId, runtime: { state, authoritative, ...(r && typeof r.activityPhase === 'string' ? { activityPhase: r.activityPhase.slice(0, 64) } : {}),
            ...(r && typeof r.activityAttention === 'boolean' ? { attention: r.activityAttention } : {}) }, queue };
        });
        return deliver({ deviceId, sessions, observedAt: Date.now(), partial });
      }
      const limit = params.limit ?? 50;
      if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100) return fail('INVALID_PARAMS');
      const order = params.order ?? 'desc';
      if (order !== 'asc' && order !== 'desc') return fail('INVALID_PARAMS');
      const workdir = params.workdir === undefined ? null : identifier(params.workdir);
      const agentKind = params.agentKind ?? null;
      if (agentKind !== null && agentKind !== 'cc' && agentKind !== 'codex' && agentKind !== 'pi') return fail('INVALID_PARAMS');
      const time = (v: unknown): number | null => v === undefined ? null : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 8640000000000000 ? v : fail('INVALID_PARAMS');
      const fromMs = time(params.fromMs), toMs = time(params.toMs);
      if (fromMs !== null && toMs !== null && fromMs >= toMs) return fail('INVALID_PARAMS');
      const sessionId = method === 'observation/history' ? identifier(params.sessionId) : null;
      if (method === 'observation/sessions' && params.sessionId !== undefined) return fail('INVALID_PARAMS');
      const binding = JSON.stringify([method, deviceId, sessionId, order, workdir, agentKind, fromMs, toMs]);
      let cursor: unknown = null;
      if (params.cursor !== undefined) {
        try {
          cursor = sourceCursor(decodeToken(params.cursor, binding));
          if (cursor === null) return fail('INVALID_CURSOR');
        } catch { return fail('INVALID_CURSOR'); }
      }
      if (method === 'observation/history' && typeof cursor === 'string') return fail('INVALID_CURSOR');
      const args: Omit<ObservationSessionsParams, 'includeDeleted'> = { workdir, agentKind, fromMs, toMs, order, limit: Number(limit), cursor: cursor as ObservationSessionsParams['cursor'] };
      const raw = method === 'observation/sessions'
        ? await checked(() => deps.sessions(deviceId, { ...args, includeDeleted: false }, assertCurrent))
        : await checked(() => deps.history(deviceId, sessionId!, { ...args, cursor: args.cursor as GetMessagesParams['cursor'], sessionIds: [sessionId!],
          roles: ['user', 'assistant', 'ask_user', 'plan_review'], includeRewound: false }, assertCurrent));
      const p = page(raw, Number(limit));
      if (method === 'observation/history' && typeof p.cursor === 'string') return fail('INVALID_RESPONSE');
      const nextCursor = p.cursor === null ? null : encodeToken(binding, p.cursor);
      if (method === 'observation/sessions') {
        const sessions = p.items.map((r) => {
          let sessionUrl: string | undefined;
          if (typeof r.sessionUrl === 'string' && r.sessionUrl.length <= 2048) {
            try {
              const url = new URL(r.sessionUrl);
              if (DEEP_LINK_SCHEMES.some((scheme) => url.protocol === `${scheme}:`) && url.hostname === 'session'
                && decodeURIComponent(url.pathname.slice(1)) === r.id
                && !url.username && !url.password && !url.hash && !!url.searchParams.get('device')
                && (deviceId === 'local' || url.searchParams.get('device') === deviceId)
                && [...url.searchParams.keys()].every((key) => key === 'device')) sessionUrl = r.sessionUrl;
            } catch { /* Malformed source links are omitted, never exposed as navigable URLs. */ }
          }
          return { sessionId: identifier(r.id, 'INVALID_RESPONSE'),
            ...metadata(r, ['title', 'workingDir', 'agentKind', 'status', 'source', 'createdAt', 'updatedAt', 'lastActivityAt', 'messageCount']),
            ...(sessionUrl ? { sessionUrl } : {}) };
        });
        return deliver({ deviceId, sessions, nextCursor, hasMore: p.hasMore, observedAt: Date.now(), partial: false });
      }
      let remaining = 12000, partial = false;
      const messages = p.items.flatMap((r) => {
        if (!['user', 'assistant', 'ask_user', 'plan_review'].includes(String(r.role)) || r.rewindAt != null) { partial = true; return []; }
        const id = identifier(r.id, 'INVALID_RESPONSE');
        const original = text(r.content);
        const meta = r.agentMeta && typeof r.agentMeta === 'object' && !Array.isArray(r.agentMeta)
          ? r.agentMeta as Record<string, unknown> : null;
        if (r.role === 'user' && (meta?.autoResume === true || isSyntheticTriggerText(original.value))) {
          partial = true;
          return [];
        }
        const content = original.value.slice(0, Math.min(8000, remaining));
        remaining -= content.length;
        const upstreamTruncated = !!r.agentMeta && typeof r.agentMeta === 'object'
          && !Array.isArray(r.agentMeta) && (r.agentMeta as Record<string, unknown>).remoteContentTruncated === true;
        const truncated = upstreamTruncated || original.incomplete || original.value.length > content.length;
        partial ||= truncated;
        return [{ id, sessionId, ...metadata(r, ['clientId', 'role', 'createdAt']), text: content, truncated }];
      });
      return deliver({ deviceId, sessionId, messages, nextCursor, hasMore: p.hasMore, observedAt: Date.now(), partial });
    },
  };
}
