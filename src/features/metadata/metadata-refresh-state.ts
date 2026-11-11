export type RefreshPhase = 'idle' | 'backingUp' | 'running' | 'completed' | 'stopped' | 'failed';
export interface RefreshOutcome {
  gameId: number; title: string; status: 'updated' | 'needsReview' | 'needsAuthorization' | 'failed' | 'skipped'; message: string;
}
export interface RefreshState {
  phase: RefreshPhase; runId: number; revision: number; total: number; processed: number; updated: number;
  needsReview: number; failed: number; skipped: number; currentTitle: string | null;
  backupPath: string | null; error: string | null; outcomes: RefreshOutcome[];
}
const phaseOrder: Record<RefreshPhase, number> = { idle: 0, backingUp: 1, running: 2, completed: 3, stopped: 3, failed: 3 };
/** A late status/command response must not roll progress back behind an event. */
export function acceptRefreshState(current: RefreshState | null, next: RefreshState): RefreshState {
  if (!current || next.runId > current.runId) return next;
  // Pending counters can decrease after manual confirmation. The backend's
  // revision orders those mutations even at equal phase/processed progress.
  if (next.runId === current.runId && current.revision !== undefined && next.revision !== undefined) {
    return next.revision > current.revision ? next : current;
  }
  if (next.runId < current.runId || next.processed < current.processed || phaseOrder[next.phase] < phaseOrder[current.phase]) return current;
  if (phaseOrder[current.phase] === 3 && next.phase !== current.phase) return current;
  if (next.updated < current.updated || next.needsReview < current.needsReview || next.failed < current.failed || next.skipped < current.skipped || next.outcomes.length < current.outcomes.length) return current;
  return next;
}
export function isRefreshActive(state: RefreshState | null): boolean {
  return state?.phase === 'backingUp' || state?.phase === 'running';
}
