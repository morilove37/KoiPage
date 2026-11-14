import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor, runAgent, TOOLS, launchChecked } from '../src/features/ai/agent.ts';
import { createGameProcessController } from '../src/features/launch/process-state.ts';

function fixture() {
  const writes = [];
  const games = [
    { id: 1, title: 'Alpha', status: 'unplayed', rating: 7, favorite: 0, installPath: 'SECRET', notes: 'PRIVATE' },
    { id: 2, title: 'Beta', status: 'completed', rating: 9, favorite: 1, exePath: 'SECRET' },
  ];
  const deps = { list: async () => games, get: async id => ({ ...games.find(g => g.id === id), tags: [3] }),
    tags: async () => [{ id: 3, name: '原标签' }], stats: async () => ({ total: 2 }),
    update: async (id, patch) => { writes.push({ id, patch }); return { ...games[0], ...patch }; },
    open: async id => { writes.push({ open: id }); }, launch: async id => { writes.push({ launch: id }); return { kind: 'started' }; },
    confirmLaunch: async () => true, changed: () => {},
  };
  return { writes, deps, execute: createToolExecutor(deps) };
}
const call = (name, args = {}, id = 'c1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

test('AI tools project metadata without disclosing paths or notes and paginate sorted results', async () => {
  const { execute } = fixture();
  const result = await execute(call('list_games', { sort: 'rating', limit: 1 }));
  assert.equal(result.total, 2);
  assert.equal(result.games[0].id, 2);
  assert.equal(result.nextOffset, 1);
  assert.doesNotMatch(JSON.stringify(result), /SECRET|PRIVATE|installPath|exePath|notes/);
});

test('unknown tools, forged IDs and invalid patches cannot write', async () => {
  const { execute, writes } = fixture();
  await assert.rejects(execute(call('delete_game', { id: 1 })), /不支持/);
  await assert.rejects(execute(call('update_game', { id: 1, status: 'completed' })), /先查询/);
  await execute(call('list_games'));
  for (const args of [{ id: 1, status: 'bad' }, { id: 1, favorite: 'yes' }, { id: 1, exePath: 'evil' }, { id: 1, addTags: [5] }]) {
    await assert.rejects(execute(call('update_game', args)));
  }
  assert.deepEqual(writes, []);
});

test('status and additive tags use the existing transactional patch without replacing old tags', async () => {
  const { execute, writes } = fixture();
  await execute(call('list_games'));
  await execute(call('update_game', { id: 1, status: 'completed', addTags: [' 收藏 ', '收藏'] }));
  assert.deepEqual(writes, [{ id: 1, patch: { status: 'completed', tagNames: ['收藏'] } }]);
});

test('launch confirmation rejection prevents launch', async () => {
  const f = fixture(); f.deps.confirmLaunch = async () => false;
  await f.execute(call('list_games'));
  const result = await f.execute(call('launch_game', { id: 1 }));
  assert.equal(result.cancelled, true);
  assert.deepEqual(f.writes, []);
});

test('agent returns actual tool errors to model and ends on final text', async () => {
  const history = [{ role: 'user', content: '查询' }]; let requests = 0;
  const events = [];
  await runAgent({ history, signal: new AbortController().signal,
    request: async messages => { requests++; return requests === 1 ? { role: 'assistant', content: null, tool_calls: [call('get_stats')] } : { role: 'assistant', content: '查询失败' }; },
    execute: async () => { throw new Error('数据库不可用'); }, onEvent: e => events.push(e) });
  assert.equal(requests, 2);
  assert.match(history[2].content, /操作失败/);
  assert.match(events.find(e => e.kind === 'tool').text, /数据库不可用/);
  assert.equal(events.find(e => e.kind === 'tool').ok, false);
  assert.equal(events.at(-1).text, '查询失败');
});

test('agent continues past the former twelve-round and twenty-call limits', async () => {
  const history = [{ role: 'user', content: '整理整个游戏库' }]; let requests = 0; const events = [];
  await runAgent({ history, signal: new AbortController().signal,
    request: async () => {
      requests++;
      if (requests <= 15) {
        const calls = Array.from({ length: requests === 1 ? 25 : 1 }, (_, i) => call('get_stats', {}, `r${requests}-${i}`));
        return { role: 'assistant', content: null, tool_calls: calls };
      }
      return { role: 'assistant', content: '全部完成' };
    },
    execute: async () => ({ done: true }), onEvent: e => events.push(e) });
  assert.equal(requests, 16, 'must keep going past the old 12-round cap');
  assert.equal(history.filter(m => m.role === 'tool').length, 25 + 14, 'all calls in a turn must run');
  assert.equal(events.at(-1).text, '全部完成');
});

test('tool events expose the concrete game name for the operation log', async () => {
  const f = fixture(); const history = [{ role: 'user', content: '改一下' }]; const events = []; let n = 0;
  await runAgent({ history, signal: new AbortController().signal,
    request: async () => ++n === 1
      ? { role: 'assistant', tool_calls: [call('list_games', { search: 'Alpha' }, 'l1'), call('update_game', { id: 1, rating: 8 }, 'u1')] }
      : { role: 'assistant', content: '完成' },
    execute: f.execute, onEvent: e => events.push(e) });
  const tools = events.filter(e => e.kind === 'tool');
  assert.equal(tools[0].name, 'list_games');
  assert.equal(tools[0].detail, '搜索「Alpha」');
  assert.equal(tools[1].name, 'update_game');
  assert.equal(tools[1].detail, 'Alpha');
});

test('token usage from each response is reported as a usage event', async () => {
  const history = [{ role: 'user', content: '你好' }]; const events = [];
  await runAgent({ history, signal: new AbortController().signal,
    request: async () => ({ role: 'assistant', content: '收到', usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 } }),
    execute: async () => ({}), onEvent: e => events.push(e) });
  const usage = events.filter(e => e.kind === 'usage');
  assert.equal(usage.length, 1);
  assert.deepEqual(usage[0].usage, { promptTokens: 12, completionTokens: 3, totalTokens: 15 });
  assert.equal(events.filter(e => e.kind === 'text').at(-1).text, '收到');
});

test('stopping during a response prevents any tool execution and leaves usable history', async () => {
  const control = new AbortController(); let actions = 0;
  const history = [{ role: 'user', content: '操作' }];
  await assert.rejects(runAgent({ history, signal: control.signal,
    request: async () => { control.abort(); return { role: 'assistant', tool_calls: [call('get_stats')] }; },
    execute: async () => { actions++; }, onEvent: () => {} }));
  assert.equal(actions, 0);
  assert.equal(history.length, 1);
});

test('tool schema exposes no filesystem, shell, delete or credential tools', () => {
  assert.deepEqual(TOOLS.map(t => t.function.name), ['list_games', 'get_game', 'get_stats', 'update_game', 'open_game', 'launch_game']);
});

test('path-bearing tool failures stay local and are not sent upstream', async () => {
  const history = [{ role: 'user', content: '启动' }]; let n = 0; const events = [];
  await runAgent({ history, signal: new AbortController().signal,
    request: async () => ++n === 1 ? { role: 'assistant', tool_calls: [call('launch_game', { id: 1 })] } : { role: 'assistant', content: '启动失败' },
    execute: async () => { throw new Error('找不到可执行文件：C:\\Users\\private\\games\\game.exe'); }, onEvent: event => events.push(event),
  });
  assert.doesNotMatch(JSON.stringify(history), /private|game.exe|Users/);
  assert.match(events.find(e => e.kind === 'tool').text, /private/);
});

test('stopping during the launcher running check prevents a new launch IPC', async () => {
  let resume; let launches = 0;
  const controller = createGameProcessController({
    readRunning: () => new Promise(resolve => { resume = resolve; }),
    launch: async () => { launches++; return { pid: 1, sessionId: 1 }; }, stop: async () => true, onChange: () => {},
  });
  const control = new AbortController();
  const result = launchChecked(controller, 1, control.signal);
  control.abort(); resume(false); await result;
  assert.equal(launches, 0);
});

test('safe validation errors tell the model how to recover without exposing IPC details', async () => {
  const { execute } = fixture(); const history = [{ role: 'user', content: '收藏这个游戏' }]; let n = 0;
  await runAgent({ history, signal: new AbortController().signal, execute,
    request: async () => ++n === 1 ? { role: 'assistant', tool_calls: [call('update_game', { id: 1, favorite: true })] } : { role: 'assistant', content: '需要先查询' }, onEvent: () => {},
  });
  assert.match(history[2].content, /先查询/);
});

test('AI can update library metadata and replace a fully read description', async () => {
  const f = fixture(); const description = '原文简介\n第二段';
  const get = f.deps.get; f.deps.get = async id => ({ ...await get(id), description });
  await f.execute(call('list_games'));
  await f.execute(call('get_game', { id: 1 }));
  const patch = { title: ' 中文名称 ', originalTitle: 'Original', developer: '制作组', releaseDate: '2024-02-29', rating: 8.75, description: '翻译后的简介\n保留分段' };
  const result = await f.execute(call('update_game', { id: 1, ...patch }));
  assert.deepEqual(f.writes, [{ id: 1, patch: { ...patch, title: '中文名称' } }]);
  assert.equal(result.updated, true);
});

test('long descriptions are read in complete sequential pages before replacement', async () => {
  const f = fixture(); const source = '原'.repeat(8000) + '必须翻译的结尾';
  const get = f.deps.get; f.deps.get = async id => ({ ...await get(id), description: source });
  await f.execute(call('list_games'));
  const first = await f.execute(call('get_game', { id: 1 }));
  assert.equal(first.descriptionLength, source.length);
  assert.equal(first.nextDescriptionOffset, 8000);
  assert.equal(first.descriptionComplete, false);
  await assert.rejects(f.execute(call('update_game', { id: 1, description: '只翻译了前半段' })), /完整/);
  const second = await f.execute(call('get_game', { id: 1, descriptionOffset: first.nextDescriptionOffset }));
  assert.equal(first.description + second.description, source);
  assert.equal(second.descriptionComplete, true);
  await f.execute(call('update_game', { id: 1, description: '完整译文' }));
  assert.equal(f.writes.length, 1);
});

test('metadata validation rejects bad dates, ratings, empty names and path changes before writing', async () => {
  const { execute, writes } = fixture(); await execute(call('list_games')); await execute(call('get_game', { id: 1 }));
  for (const patch of [{ title: ' ' }, { title: 5 }, { developer: {} }, { releaseDate: '2025-02-29' }, { releaseDate: '2024/01/01' }, { rating: 11 }, { rating: '8' }, { description: {} }, { description: 'x'.repeat(30001) }, { installPath: 'C:/other' }, { launchArgs: 'anything' }, { notes: 'private' }]) {
    await assert.rejects(execute(call('update_game', { id: 1, ...patch })));
  }
  assert.equal(writes.length, 0);
});

test('nullable metadata can be cleared and description edits detect changes made since reading', async () => {
  const f = fixture(); let source = '原简介';
  const get = f.deps.get; f.deps.get = async id => ({ ...await get(id), description: source });
  await f.execute(call('list_games')); await f.execute(call('get_game', { id: 1 }));
  source = '用户刚刚改过的简介';
  await assert.rejects(f.execute(call('update_game', { id: 1, description: '旧原文的翻译' })), /重新读取/);
  assert.equal(f.writes.length, 0);
  await f.execute(call('get_game', { id: 1 }));
  await f.execute(call('update_game', { id: 1, originalTitle: null, developer: null, releaseDate: null, rating: null, description: null }));
  assert.deepEqual(f.writes[0].patch, { originalTitle: null, developer: null, releaseDate: null, rating: null, description: null });
});
