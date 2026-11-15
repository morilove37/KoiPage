export interface VerificationSnapshot {
  phase: 'idle' | 'opening' | 'ready' | 'syncing' | 'error';
  opened: boolean;
  error: string | null;
}

export function createVerificationFlow(transport: {
  open: () => Promise<void>;
  sync: () => Promise<void>;
  changed: (snapshot: VerificationSnapshot) => void;
}) {
  let state: VerificationSnapshot = { phase: 'idle', opened: false, error: null };
  let generation = 0;
  const busy = () => state.phase === 'opening' || state.phase === 'syncing';
  const publish = (patch: Partial<VerificationSnapshot>) => {
    state = { ...state, ...patch };
    transport.changed(state);
  };
  const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
  return {
    snapshot: () => state,
    open: async () => {
      if (busy()) return;
      const ticket = ++generation;
      publish({ phase: 'opening', error: null });
      try {
        await transport.open();
        if (ticket === generation) publish({ phase: 'ready', opened: true });
      } catch (cause) {
        if (ticket === generation) publish({ phase: 'error', error: message(cause) });
      }
    },
    complete: async (retry?: () => Promise<void>) => {
      if (busy() || !state.opened) return;
      const ticket = ++generation;
      publish({ phase: 'syncing', error: null });
      try {
        await transport.sync();
        if (ticket !== generation) return;
        // Opening or closing the browser never retries. Only this explicit
        // completion action can resume the search/detail operation.
        await retry?.();
        if (ticket === generation) publish({ phase: 'ready' });
      } catch (cause) {
        if (ticket === generation) publish({ phase: 'error', error: message(cause) });
      }
    },
    cancel: () => {
      generation += 1;
      state = { ...state, phase: state.opened ? 'ready' : 'idle' };
    },
  };
}
