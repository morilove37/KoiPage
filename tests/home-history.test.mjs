import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import React from 'react';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(new URL('../package.json', import.meta.url));
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild');
const compiled = await build({ absWorkingDir: root, bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  entryPoints: ['src/features/home/RecentPlayHistory.tsx'],
  plugins: [{ name: 'native-history-boundary', setup(builder) {
    builder.onLoad({ filter: /RecentPlayHistory\.tsx$/ }, async ({ path }) => ({
      contents: (await readFile(path, 'utf8')).replace('from "@/lib/db"', 'from "history-test-db"'), loader: 'tsx',
    }));
    builder.onResolve({ filter: /^history-test-db$/ }, () => ({ path: 'history-test-db', namespace: 'history-test' }));
    builder.onLoad({ filter: /.*/, namespace: 'history-test' }, () => ({ contents: 'export const playSessionsPage = (...args) => globalThis.homeHistoryPage(...args);', loader: 'js' }));
  } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, mod, mod.exports);
const { RecentPlayHistory } = mod.exports;

// A deterministic hook driver runs the actual component, effects and event
// handlers. Only SQLite is replaced; the returned React tree remains intact.
function mount(page, games = []) {
  globalThis.homeHistoryPage = page;
  const slots = [], pending = [];
  let cursor = 0, tree;
  const dispatcher = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], value => { slots[index] = typeof value === 'function' ? value(slots[index]) : value; }];
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useMemo(compute) { cursor++; return compute(); },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous[i])) { slots[index] = deps; pending.push(effect); }
    },
  };
  const render = () => {
    cursor = 0;
    const internal = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentDispatcher;
    const previous = internal.current; internal.current = dispatcher;
    try { tree = RecentPlayHistory({ games, refreshKey: 'test' }); } finally { internal.current = previous; }
    while (pending.length) pending.shift()();
    return tree;
  };
  const settle = async () => { await new Promise(setImmediate); render(); };
  render();
  return { render, settle, get tree() { return tree; }, click(predicate) {
    const button = nodes(tree).find(node => typeof node.props.onClick === 'function' && predicate(node));
    assert.ok(button, 'requested control exists'); button.props.onClick(); render();
  } };
}
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement(tree)) return [];
  return [tree, ...nodes(tree.props.children)];
}
const text = tree => Array.isArray(tree) ? tree.map(text).join('') : React.isValidElement(tree) ? text(tree.props.children) : tree == null || typeof tree === 'boolean' ? '' : String(tree);
const rows = tree => nodes(tree).filter(node => node.props['data-game-id'] !== undefined);
const entries = tree => nodes(tree).filter(node => node.props['data-session-id'] !== undefined);
const session = (id, gameId = 1, durationSeconds = 60) => ({ id, gameId, durationSeconds, startedAt: '2026-11-11T10:00:00Z', endedAt: '2026-11-11T10:01:00Z' });
const game = id => ({ id, title: `作品 ${id}`, coverPath: null });

test('home preview limits consecutive game groups and never renders collapsed session timelines', async () => {
  const view = mount(async () => [session(8, 1), session(7, 1), session(6, 2), session(5, 3), session(4, 1)], [1, 2, 3].map(game));
  await view.settle();
  assert.deepEqual(rows(view.tree).map(node => node.props['data-game-id']), [1, 2, 3]);
  assert.equal(entries(view.tree).length, 0);
  assert.match(text(rows(view.tree)[0]), /连续游玩 2 次/);
  assert.match(text(rows(view.tree)[0]), /合计 2 分钟/);
  assert.ok(nodes(rows(view.tree)[0]).some(node => node.type === 'time' && node.props.dateTime === '2026-11-11T10:00:00Z'));
  assert.ok(nodes(view.tree).some(node => node.props.to === '/library/1?tab=history'));
});

test('view all contains every loaded group within one bounded region, with independent lazy timelines', async () => {
  const view = mount(async () => [session(5), session(4), session(3, 2), session(2, 3), session(1, 1)], [1, 2, 3].map(game));
  await view.settle();
  view.click(node => node.props['aria-label'] === '展开全部游玩记录');
  const region = nodes(view.tree).find(node => node.props.role === 'region' && node.props['aria-label'] === '全部游玩记录');
  assert.ok(region, 'all history has a named scroll region');
  assert.match(region.props.className, /max-h-96/);
  assert.match(region.props.className, /overflow-y-auto/);
  assert.equal(rows(region).length, 4);
  assert.equal(rows(view.tree).length, 4, 'preview must not duplicate rows outside scroll region');
  assert.equal(entries(view.tree).length, 0);
  view.click(node => node.props['aria-label'] === '展开作品 1的游玩明细');
  assert.deepEqual(entries(view.tree).map(node => node.props['data-session-id']), [5, 4]);
  const timeline = nodes(view.tree).find(node => node.type === 'ol' && node.props['aria-label'] === '作品 1的游玩明细');
  assert.match(timeline.props.className, /max-h-48/);
  view.click(node => node.props['aria-label'] === '展开作品 2的游玩明细');
  assert.deepEqual(entries(view.tree).map(node => node.props['data-session-id']), [5, 4, 3]);
  view.click(node => node.props['aria-label'] === '收起作品 1的游玩明细');
  assert.deepEqual(entries(view.tree).map(node => node.props['data-session-id']), [3], 'another group remains open');
  view.click(node => node.props['aria-label'] === '收起全部游玩记录');
  assert.deepEqual(rows(view.tree).map(node => node.props['data-game-id']), [1, 2, 3]);
});

test('100 same-game sessions stay lazy and a loaded page extends the open group without duplicating sessions', async () => {
  const all = Array.from({ length: 100 }, (_, index) => session(100 - index));
  let calls = 0;
  const view = mount(async (size, cursor) => { calls++; assert.equal(size, 51); return cursor ? all.slice(50) : all.slice(0, 51); }, [game(1)]);
  await view.settle();
  assert.equal(entries(view.tree).length, 0);
  view.click(node => node.props['aria-label'] === '展开全部游玩记录');
  view.click(node => node.props['aria-label'] === '展开作品 1的游玩明细');
  assert.equal(entries(view.tree).length, 50);
  view.click(node => text(node) === '加载更早记录');
  await view.settle();
  assert.equal(calls, 2);
  assert.equal(rows(view.tree).length, 1);
  assert.equal(entries(view.tree).length, 100);
  assert.match(text(view.tree), /连续游玩 100 次/);
  view.click(node => node.props['aria-label'] === '收起作品 1的游玩明细');
  assert.equal(entries(view.tree).length, 0);
});

test('initial and pagination failures remain retryable and removed games remain readable', async () => {
  let initial = true, more = true;
  const firstPage = Array.from({ length: 51 }, (_, i) => session(100 - i));
  const view = mount(async (_size, cursor) => {
    if (!cursor && initial) { initial = false; throw new Error('initial offline'); }
    if (cursor && more) { more = false; throw new Error('page offline'); }
    return cursor ? [session(49)] : firstPage;
  });
  await view.settle();
  assert.match(text(view.tree), /initial offline/);
  view.click(node => text(node) === '重试游玩记录'); await view.settle();
  assert.match(text(view.tree), /已移除的作品/);
  assert.equal(nodes(view.tree).some(node => node.props.to), false);
  view.click(node => node.props['aria-label'] === '展开全部游玩记录');
  view.click(node => text(node) === '加载更早记录'); await view.settle();
  assert.match(text(view.tree), /page offline/);
  view.click(node => text(node) === '加载更早记录'); await view.settle();
  assert.doesNotMatch(text(view.tree), /page offline/);
  assert.match(text(view.tree), /全部 51 次游玩/);
});
