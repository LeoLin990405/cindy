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
      if (deviceId === 'local') return getMessagesForHistory(args);
      // Preserve types until the observation boundary filters tools/thinking and hidden inputs.
      // The MCP text-capping adapter flattens objects first and can destroy that evidence.
      const result = await invoke(deviceId, DL_HISTORY_MESSAGES_CHANNEL, [{
        sessionId, workdir: args.workdir, fromMs: args.fromMs, toMs: args.toMs,
        agentKind: args.agentKind, roles: args.roles, includeRewound: false,
        limit: args.limit, cursor: args.cursor, order: args.order, contentCharLimit: null,
      }], assertCurrent);
      if (Buffer.byteLength(JSON.stringify(result.result)) > 1024 * 1024)
        throw new LocalAgentObservationError('REMOTE_PAYLOAD_TOO_LARGE');
      return result.result;
    },
    async runtime(deviceId, sessionIds, assertCurrent) {
      if (deviceId === 'local') return {
        format: 'active-sessions-v2',
        sessions: maker.listActiveSessions().filter((s) => sessionIds.includes(s.id)).map((s) => ({
          sessionId: s.id, isTurnRunning: s.isTurnRunning(),
        })),
      };
      return (await invoke(deviceId, 'maker:list-active', [{ summary: true, snapshotVersion: 2 }], assertCurrent)).result;
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
