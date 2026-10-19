export type GameProcessState = {
  status: 'idle' | 'starting' | 'running';
  pid: number | null;
  sessionId: number | null;
};

interface LaunchResult { pid: number; sessionId: number }
interface Dependencies {
  readRunning: (gameId: number) => Promise<boolean>;
  launch: (gameId: number) => Promise<LaunchResult>;
  stop: (gameId: number) => Promise<boolean>;
  onChange: (gameId: number, state: GameProcessState) => void;
}

type StartOutcome =
  | { kind: 'busy' | 'running' | 'panel' }
  | { kind: 'started'; result: LaunchResult };

/** Coordinates backend observations and commands without allowing old replies to
 * undo a launch/exit. Each game has its own lock, so unrelated games still work. */
export function createGameProcessController(dependencies: Dependencies) {
  const states = new Map<number, GameProcessState>();
  const versions = new Map<number, number>();
  const queries = new Map<number, number>();
  const operations = new Map<number, Set<number>>();
  const idle: GameProcessState = { status: 'idle', pid: null, sessionId: null };
  const state = (id: number) => states.get(id) ?? idle;
  const version = (id: number) => versions.get(id) ?? 0;

  function publish(id: number, next: GameProcessState) {
    versions.set(id, version(id) + 1);
    states.set(id, next);
    dependencies.onChange(id, next);
  }

  async function refresh(id: number) {
    const generation = version(id);
    const query = (queries.get(id) ?? 0) + 1;
    queries.set(id, query);
    const running = await dependencies.readRunning(id);
    if (generation !== version(id) || query !== queries.get(id) || operations.has(id)) return;
    publish(id, running ? { ...state(id), status: 'running' } : idle);
  }

  function exited(id: number, sessionId: number) {
    operations.get(id)?.add(sessionId);
    // A delayed event from an earlier session must not clear a newer process.
    if (state(id).sessionId !== null && state(id).sessionId !== sessionId) return;
    publish(id, idle);
  }

  async function start(id: number, beforeLaunch?: () => Promise<boolean>): Promise<StartOutcome> {
    if (operations.has(id)) return { kind: 'busy' };
    const exitedSessions = new Set<number>();
    operations.set(id, exitedSessions);
    publish(id, { status: 'starting', pid: null, sessionId: null });
    try {
      const generation = version(id);
      if (await dependencies.readRunning(id)) {
        if (generation === version(id)) publish(id, { status: 'running', pid: null, sessionId: null });
        return { kind: 'running' };
      }
      if (beforeLaunch && !(await beforeLaunch())) return { kind: 'panel' };
      const result = await dependencies.launch(id);
      // A short-lived process can emit game-exited before launch_game replies.
      publish(id, exitedSessions.has(result.sessionId)
        ? idle
        : { status: 'running', pid: result.pid, sessionId: result.sessionId });
      return { kind: 'started', result };
    } finally {
      operations.delete(id);
      if (state(id).status === 'starting') publish(id, idle);
    }
  }

  async function stop(id: number) {
    if (operations.has(id)) return false;
    operations.set(id, new Set());
    try {
      const stopped = await dependencies.stop(id);
      publish(id, idle);
      return stopped;
    } finally {
      operations.delete(id);
    }
  }

  return { refresh, exited, start, stop };
}
