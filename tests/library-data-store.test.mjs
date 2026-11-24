import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');

// The store only needs the four read commands and one settings read; stubbing
// `@/lib/db` keeps the real Tauri bridge (and therefore SQLite) out of the test.
// The signal is exported from the same bundle so the test and the store share
// one listener registry instead of two module instances.
const compiled = await build({
  absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  stdin: {
    contents: `
      export * from './src/features/library/data-store';
      export { notifyLibraryDataChanged, onLibraryDataChanged } from './src/lib/library-signal';
    `,
    resolveDir: root, loader: 'ts',
  },
  plugins: [{
    name: 'stub-db',
    setup(builder) {
      builder.onResolve({ filter: /^@\/lib\/db$/ }, () => ({ path: 'stub-db', namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
        contents: `
          export const gamesList = (...args) => globalThis.__db.gamesList(...args);
          export const tagsList = (...args) => globalThis.__db.tagsList(...args);
          export const gamesTagsGet = (...args) => globalThis.__db.gamesTagsGet(...args);
          export const gamesStats = (...args) => globalThis.__db.gamesStats(...args);
          export const settingsGet = (...args) => globalThis.__db.settingsGet(...args);
        `,
        loader: 'js',
      }));
    },
  }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const {
  ensureLibraryData, refreshLibraryData, seedLibraryFolders, readLibraryFolders,
  applyLibraryFolders, setLibraryGames, setLibraryStats, useLibraryDataStore,
  notifyLibraryDataChanged,
} = mod.exports;

const flush = async () => { await new Promise(setImmediate); await new Promise(setImmediate); };

const GAME = { id: 1, title: '星空', developer: null, status: 'completed' };
const TAG = { id: 7, name: '纯爱', color: null };
const STATS = { total: 1, favorite: 0, playTimeSeconds: 60, byStatus: {} };

/**
 * A controllable database stub: every read is queued so a test can hold it open
 * and assert what the UI would be showing at that moment.
 */
function stubDb(overrides = {}) {
  const calls = { gamesList: 0, tagsList: 0, gamesTagsGet: 0, gamesStats: 0, settingsGet: 0 };
  const pending = [];
  const hold = () => new Promise(resolve => pending.push(resolve));
  const db = {
    calls,
    /** Resolve every held read. */
    release() { const batch = pending.splice(0); for (const resolve of batch) resolve(); },
    gamesList: async () => { calls.gamesList += 1; await hold(); return [GAME]; },
    tagsList: async () => { calls.tagsList += 1; await hold(); return [TAG]; },
    gamesTagsGet: async () => { calls.gamesTagsGet += 1; await hold(); return [[1, 7]]; },
    gamesStats: async () => { calls.gamesStats += 1; await hold(); return STATS; },
    settingsGet: async () => { calls.settingsGet += 1; return null; },
    ...overrides,
  };
  globalThis.__db = db;
  return db;
}

function reset() {
  useLibraryDataStore.setState({
    games: [], tags: [], links: [], stats: null, folders: [], loaded: false,
    foldersLoaded: false, loading: true, refreshing: false, revision: 0, error: null,
  });
}

test('concurrent first loads share a single round of reads', async () => {
  const db = stubDb();
  reset();
  const first = ensureLibraryData();
  const second = ensureLibraryData();
  assert.equal(db.calls.gamesList, 1, 'the second caller joins the in-flight request');
  assert.equal(useLibraryDataStore.getState().loading, true, 'a blank cache shows the loading state');
  db.release();
  await Promise.all([first, second]);
  const state = useLibraryDataStore.getState();
  assert.deepEqual(state.games, [GAME]);
  assert.deepEqual(state.tags, [TAG]);
  assert.deepEqual(state.links, [[1, 7]]);
  assert.deepEqual(state.stats, STATS);
  assert.equal(state.loaded, true);
  assert.equal(state.loading, false);
  assert.equal(state.revision, 1);
});

test('a second navigation does not re-read rows that are already cached', async () => {
  const db = stubDb();
  reset();
  const first = ensureLibraryData();
  db.release();
  await first;
  await ensureLibraryData();
  assert.equal(db.calls.gamesList, 1, 'coming back to a page must not refetch');
});

test('a refresh keeps the rows on screen and never flips the loading flag', async () => {
  const db = stubDb();
  reset();
  const first = ensureLibraryData();
  db.release();
  await first;

  const refresh = refreshLibraryData();
  const during = useLibraryDataStore.getState();
  assert.deepEqual(during.games, [GAME], 'cached rows stay visible while the refresh runs');
  assert.equal(during.loading, false, 'a background refresh must not blank the page');
  assert.equal(during.refreshing, true);

  db.release();
  await refresh;
  assert.equal(useLibraryDataStore.getState().refreshing, false);
  assert.equal(useLibraryDataStore.getState().revision, 2);
});

test('a failed refresh keeps the cached rows and records the error', async () => {
  const db = stubDb();
  reset();
  const first = ensureLibraryData();
  db.release();
  await first;

  stubDb({ gamesList: async () => { throw new Error('数据库已锁定'); } });
  const failing = refreshLibraryData();
  await failing;

  const state = useLibraryDataStore.getState();
  assert.deepEqual(state.games, [GAME], 'a failed refresh must not wipe the screen');
  assert.equal(state.error, '数据库已锁定');
  assert.equal(state.loading, false);
  assert.equal(state.refreshing, false);
});

test('a write elsewhere invalidates the cache through the shared signal', async () => {
  const db = stubDb();
  reset();
  const first = ensureLibraryData();
  db.release();
  await first;
  assert.equal(db.calls.gamesList, 1);

  notifyLibraryDataChanged();
  await flush();
  assert.equal(db.calls.gamesList, 2, 'a write has to trigger a refresh, not wait for a restart');
  db.release();
  await flush();
  assert.equal(useLibraryDataStore.getState().revision, 2);
});

test('a write that lands during a read forces one more round instead of stale rows', async () => {
  const db = stubDb();
  reset();
  const first = ensureLibraryData();
  // The read is still open when a write completes: the rows it is about to
  // return may predate that write, so they must not be the final answer.
  notifyLibraryDataChanged();
  db.release();
  await first;
  await flush();
  assert.equal(db.calls.gamesList, 2, 'the stale read is followed by a fresh one');
  db.release();
  await flush();
  assert.equal(db.calls.gamesList, 2, 'and that second read is not repeated again');
});

test('a failing write subscriber does not break the notification loop', () => {
  reset();
  // A listener that throws must not prevent later listeners (the cache) from
  // running: the signal is fired from inside successful writes.
  const { onLibraryDataChanged } = mod.exports;
  const seen = [];
  const offBad = onLibraryDataChanged(() => { throw new Error('boom'); });
  const offGood = onLibraryDataChanged(() => { seen.push('ok'); });
  const warn = console.warn;
  console.warn = () => {};
  try { notifyLibraryDataChanged(); } finally { console.warn = warn; offBad(); offGood(); }
  assert.deepEqual(seen, ['ok']);
});

test('folder definitions are seeded from the startup settings snapshot', () => {
  reset();
  const snapshot = new Map([['library.custom-folders.v1', JSON.stringify([{ id: 'a', name: '神作', gameIds: [1, 1, -3] }])]]);
  seedLibraryFolders(snapshot);
  const state = useLibraryDataStore.getState();
  assert.equal(state.foldersLoaded, true);
  assert.deepEqual(state.folders, [{ id: 'a', name: '神作', gameIds: [1] }]);
});

test('a snapshot without the folder key seeds an empty, already-loaded list', () => {
  reset();
  // `settings_get_all` answered every key, so an absent folder key means "no
  // folders configured" — the folder page must not wait for a second read.
  seedLibraryFolders(new Map());
  const state = useLibraryDataStore.getState();
  assert.equal(state.foldersLoaded, true);
  assert.deepEqual(state.folders, []);
});

test('reading folders falls back to an empty list for a missing setting', async () => {
  stubDb();
  assert.deepEqual(await readLibraryFolders(), []);
});

test('optimistic game and stats updates land in the shared cache', () => {
  reset();
  setLibraryGames([GAME]);
  setLibraryGames(current => current.map(game => ({ ...game, favorite: 1 })));
  setLibraryStats(STATS);
  const state = useLibraryDataStore.getState();
  assert.deepEqual(state.games, [{ ...GAME, favorite: 1 }]);
  assert.deepEqual(state.stats, STATS);
});

test('applying folders marks them loaded so the page can enable its controls', () => {
  reset();
  applyLibraryFolders([{ id: 'b', name: 'B', gameIds: [] }]);
  assert.equal(useLibraryDataStore.getState().foldersLoaded, true);
  assert.deepEqual(useLibraryDataStore.getState().folders, [{ id: 'b', name: 'B', gameIds: [] }]);
});
