import type { Maker } from '@cindy/maker-core';
import { DeviceLinkError, DL_HISTORY_MESSAGES_CHANNEL } from '@cindy/device-link';
import { remoteInvoke } from '../device-link/index.js';
import { handleListDevices, defaultDeps } from '../device-link/ipc.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../device-link/broadcast-tap.js';
import { listSessionsForHistory, getMessagesForHistory } from '../localDb/chatHistoryReader.js';
import { buildHistorySessionDeepLink } from '../deepLink.js';
import { getDeviceId } from '../authManager.js';
import type { SessionQueueInspectionEntry } from '../maker-ipc/sessionQueueInspection.js';
import { createHistoryRemoteDeps } from '../mcp-integrations/historyDevices.js';
import { classifyRemoteHistoryError } from '../mcp-integrations/remoteChatHistory.js';
import { createLocalAgentObservation, LocalAgentObservationError, type LocalAgentObservation } from './observation.js';

const defaultCaptureAccess = () => {
  const owner = captureDataOwnerBroadcastScope();
  const assertCurrent = () => {
    if (!isDataOwnerBroadcastScopeCurrent(owner)) throw new LocalAgentObservationError('UNAUTHORIZED');
  };
  assertCurrent();
  return assertCurrent;
};

/** Parent owns grants/service wiring. This adapter never restores queues or fetches projections. */
export function createLocalAgentObservationHost(
  maker: Maker,
  captureAccess: () => () => void = defaultCaptureAccess,
  readQueue?: (sessionId: string) => readonly SessionQueueInspectionEntry[] | null | undefined,
): LocalAgentObservation {
  const invoke = async (deviceId: string, channel: string, args: unknown[], assertCurrent: () => void) => {
    assertCurrent();
    try {
      const result = await remoteInvoke(deviceId, channel, args, { preSend: assertCurrent });
      assertCurrent();
      if (!result.ok) throw new LocalAgentObservationError(classifyRemoteHistoryError(result.error.code, '').errorCode);
      return result;
    } catch (error) {
      assertCurrent();
      if (error instanceof LocalAgentObservationError) throw error;
      throw new LocalAgentObservationError(error instanceof DeviceLinkError
        ? classifyRemoteHistoryError(error.code, '').errorCode : 'REMOTE_UNAVAILABLE');
    }
  };
  // History joins retain tombstones; explicit IDs must obey the live list's visibility too.
  const assertLiveTargets = async (deviceId: string, sessionIds: string[], assertCurrent: () => void) => {
    assertCurrent();
    const assertLive = (value: unknown, id: string) => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new LocalAgentObservationError('NOT_FOUND');
      const row = value as Record<string, unknown>;
      if (row.id !== id || (row.status !== 'active' && row.status !== 'archived'))
        throw new LocalAgentObservationError('NOT_FOUND');
    };
    if (deviceId === 'local') {
      const page = await listSessionsForHistory({
        sessionIds, includeDeleted: false, workdir: null, fromMs: null, toMs: null,
        agentKind: null, cursor: null, order: 'desc', limit: sessionIds.length,
      });
      assertCurrent();
      for (const id of sessionIds) assertLive(page.items.find(row => row.id === id), id);
    } else {
      // Bound metadata fanout for inspect's at-most-32 explicit targets.
      for (let offset = 0; offset < sessionIds.length; offset += 4) {
        await Promise.all(sessionIds.slice(offset, offset + 4).map(async id => {
          const result = await invoke(deviceId, 'local-db:sessions:get', [id], assertCurrent);
          assertCurrent();
          assertLive(result.result, id);
        }));
        assertCurrent();
      }
    }
  };
  const remote = (assertCurrent: () => void) => createHistoryRemoteDeps({
    listDevices: () => handleListDevices(defaultDeps()),
    captureAccess: () => assertCurrent,
    invoke: (deviceId, channel, args) => remoteInvoke(deviceId, channel, args, { preSend: assertCurrent }),
  });
  const reader = createLocalAgentObservation({
    listDevices: (assertCurrent) => remote(assertCurrent).listDevices(),
    async sessions(deviceId, args, assertCurrent) {
      if (deviceId === 'local') {
        if (typeof args.cursor === 'string') throw new LocalAgentObservationError('INVALID_CURSOR');
        const page = await listSessionsForHistory({ ...args, cursor: args.cursor });
        assertCurrent();
        return { ...page, items: page.items.map((row) => ({ ...row,
          sessionUrl: buildHistorySessionDeepLink(`local::${row.id}`, getDeviceId()) })) };
      }
      const result = await remote(assertCurrent).query(deviceId, 'list_sessions', {
        device: 'local', limit: args.limit, order: args.order,
        ...(args.workdir !== null ? { workdir: args.workdir } : {}),
        ...(args.agentKind !== null ? { agent_kind: args.agentKind } : {}),
        ...(args.fromMs !== null ? { from: new Date(args.fromMs).toISOString() } : {}),
        ...(args.toMs !== null ? { to: new Date(args.toMs).toISOString() } : {}),
        ...(args.cursor !== null ? { cursor: args.cursor } : {}),
      });
      assertCurrent();
      if (!result.ok) {
        const codes = ['INVALID_ARGS', 'NOT_FOUND', 'REMOTE_UNSUPPORTED_QUERY', 'REMOTE_DEVICE_OFFLINE',
          'REMOTE_LINK_REQUIRED', 'DEVICE_LINK_NOT_READY', 'REMOTE_DISABLED', 'REMOTE_ACCESS_REVOKED',
          'REMOTE_UNSUPPORTED', 'REMOTE_TIMEOUT', 'REMOTE_PAYLOAD_TOO_LARGE', 'REMOTE_UNAVAILABLE',
          'HOST_NOT_READY', 'INTERNAL', 'REMOTE_INVALID_RESPONSE'];
        throw new LocalAgentObservationError(typeof result.errorCode === 'string' && codes.includes(result.errorCode)
          ? result.errorCode : 'REMOTE_INVALID_RESPONSE');
      }
      return { items: Array.isArray(result.sessions) ? result.sessions.map((value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        const row = value as Record<string, unknown>;
        return typeof row.id === 'string' && row.id.length <= 256
          ? { ...row, sessionUrl: row.sessionUrl ?? buildHistorySessionDeepLink(`${deviceId}::${row.id}`, getDeviceId()) }
          : row;
      }) : result.sessions, nextCursor: result.nextCursor, hasMore: result.hasMore };
    },
    async history(deviceId, sessionId, args, assertCurrent) {
      // Local IDs are opaque, including IDs containing '::'; never route them by parsing.
      await assertLiveTargets(deviceId, [sessionId], assertCurrent);
      assertCurrent();
      if (deviceId === 'local') {
        const result = await getMessagesForHistory(args);
        assertCurrent();
        await assertLiveTargets(deviceId, [sessionId], assertCurrent);
        assertCurrent();
        return result;
      }
      // Preserve types until the observation boundary filters tools/thinking and hidden inputs.
      // The MCP text-capping adapter flattens objects first and can destroy that evidence.
      const result = await invoke(deviceId, DL_HISTORY_MESSAGES_CHANNEL, [{
        sessionId, workdir: args.workdir, fromMs: args.fromMs, toMs: args.toMs,
        agentKind: args.agentKind, roles: args.roles, includeRewound: false,
        limit: args.limit, cursor: args.cursor, order: args.order, contentCharLimit: null,
      }], assertCurrent);
      await assertLiveTargets(deviceId, [sessionId], assertCurrent);
      assertCurrent();
      if (Buffer.byteLength(JSON.stringify(result.result)) > 1024 * 1024)
        throw new LocalAgentObservationError('REMOTE_PAYLOAD_TOO_LARGE');
      return result.result;
    },
    async runtime(deviceId, sessionIds, assertCurrent) {
      await assertLiveTargets(deviceId, sessionIds, assertCurrent);
      assertCurrent();
      const result = deviceId === 'local' ? {
        format: 'active-sessions-v2',
        sessions: maker.listActiveSessions().filter((s) => sessionIds.includes(s.id)).map((s) => ({
          sessionId: s.id, isTurnRunning: s.isTurnRunning(),
        })),
      } : (await invoke(deviceId, 'maker:list-active', [{ summary: true, snapshotVersion: 2 }], assertCurrent)).result;
      assertCurrent();
      await assertLiveTargets(deviceId, sessionIds, assertCurrent);
      assertCurrent();
      return result;
    },
    ...(readQueue ? { readLocalQueue: readQueue } : {}),
  });
  return {
    async read(method, params, assertGrantCurrent) {
      const assertOwnerCurrent = captureAccess();
      const assertCurrent = () => { assertGrantCurrent(); assertOwnerCurrent(); };
      // The cursor key must survive requests: the reader below is created once per host.
      try {
        const result = await reader.read(method, params, assertCurrent);
        assertCurrent();
        return result;
      } catch (error) {
        assertCurrent();
        if (error instanceof LocalAgentObservationError) throw error;
        throw new LocalAgentObservationError('OBSERVATION_UNAVAILABLE');
      }
    },
  };

}
