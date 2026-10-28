import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getCurrentDbClientSnapshot } from './client/current.js';
import { sessions } from './schema.js';

export const HISTORY_OBSERVATION_COHERENCE = 'db-change-counter-v1' as const;
export interface HistoryObservationState { sourceRevision: string; clearedAt: number | null }
export function historyObservationError(code: 'HISTORY_CHANGED' | 'COHERENCE_UNSUPPORTED' | 'NOT_FOUND'): Error & { code: string } {
  return Object.assign(new Error(`[${code}] History observation is unavailable`), { code });
}

/** Optimistic, database-wide invalidation witness; no snapshot transaction or retained registry. */
export async function readHistoryObservationState(sessionId: string): Promise<HistoryObservationState> {
  const current = getCurrentDbClientSnapshot();
  if (!current?.client.readHistoryRevision) throw historyObservationError('COHERENCE_UNSUPPORTED');
  const assertCurrent = () => {
    if (getCurrentDbClientSnapshot() !== current) throw historyObservationError('HISTORY_CHANGED');
  };
  const revision = async () => {
    try { return await current.client.readHistoryRevision!(); }
    catch (error) {
      if ((error as { code?: unknown })?.code === 'HISTORY_REVISION_UNAVAILABLE')
        throw historyObservationError('COHERENCE_UNSUPPORTED');
      if ((error as { code?: unknown })?.code === 'HISTORY_CHANGED')
        throw historyObservationError('HISTORY_CHANGED');
      throw error;
    }
  };
  const before = await revision();
  assertCurrent();
  const [row] = await current.client.drizzle.select({ id: sessions.id, status: sessions.status, clearedAt: sessions.clearedAt })
    .from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  assertCurrent();
  if (!row || row.id !== sessionId || (row.status !== 'active' && row.status !== 'archived'))
    throw historyObservationError('NOT_FOUND');
  if (row.clearedAt !== null && (!Number.isSafeInteger(row.clearedAt) || row.clearedAt < 0))
    throw historyObservationError('COHERENCE_UNSUPPORTED');
  const after = await revision();
  assertCurrent();
  if (typeof after !== 'string' || !after || after.length > 256 || before !== after)
    throw historyObservationError('HISTORY_CHANGED');
  return { sourceRevision: createHash('sha256').update(`${current.clientEpoch}:${after}`).digest('hex'), clearedAt: row.clearedAt };
}
