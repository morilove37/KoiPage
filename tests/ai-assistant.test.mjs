import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createToolExecutor, runAgent, TOOLS, launchChecked } from '../src/features/ai/agent.ts';
import { createGameProcessController } from '../src/features/launch/process-state.ts';

function fixture() {
  const writes = [];
  const confirmations = [];
  const games = [
    { id: 1, title: 'Alpha', status: 'unplayed', rating: 7, favorite: 0, installPath: 'SECRET', notes: 'PRIVATE' },
    { id: 2, title: 'Beta', status: 'completed', rating: 9, favorite: 1, exePath: 'SECRET' },
  ];
  let folders = [{ id: 'folder-a', name: '已有文件夹', gameIds: [1] }];
  let confirmAnswer = true;
  const deps = { list: async () => games, get: async id => ({ ...games.find(g => g.id === id), tags: [3] }),
    tags: async () => [{ id: 3, name: '原标签' }], stats: async () => ({ total: 2 }),
    update: async (id, patch) => { writes.push({ id, patch }); return { ...games[0], ...patch }; },
    open: async id => { writes.push({ open: id }); }, launch: async id => { writes.push({ launch: id }); return { kind: 'started' }; },
    confirmLaunch: async () => true, changed: () => {},
    confirm: async preview => { confirmations.push(preview); return confirmAnswer; },
    batchUpdate: async (ids, patch) => { writes.push({ batch: ids, patch }); return ids.length; },
    searchMetadata: async query => ({ candidates: [{ provider: 'vndb', externalId: 'v1', title: 'Alpha 条目', rating: 8 }], errors: [] }),
    metadataDetail: async () => ({ provider: 'vndb', externalId: 'v1', title: 'Alpha 条目', titleOriginal: 'Alpha', developer: '制作组', releaseDate: '2024-01-01', rating: 8, description: '简介', tags: ['新标签'] }),
    applyMetadata: async (id, detail, fields, tagMode) => { writes.push({ apply: id, fields, tagMode }); return { fieldsApplied: fields, tagsAdded: 1 }; },
    folders: async () => folders,
    saveFolders: async next => { folders = next; writes.push({ folders: next.map(f => f.name) }); return true; },
    createTag: async (name, color) => { writes.push({ tag: name, color }); return { id: 9, name }; },
  };
  return { writes, confirmations, deps, setConfirm: value => { confirmAnswer = value; }, getFolders: () => folders, execute: createToolExecutor(deps) };
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
  assert.deepEqual(TOOLS.map(t => t.function.name), [
    'list_games', 'get_game', 'get_stats', 'update_game', 'open_game', 'launch_game',
    'bulk_update', 'search_metadata', 'apply_metadata', 'manage_folder', 'create_tag',
  ]);
  const forbidden = /delete|remove_file|shell|exec|write_file|read_file|credential|secret|path/i;
  for (const tool of TOOLS) {
    assert.doesNotMatch(tool.function.name, forbidden);
    assert.doesNotMatch(JSON.stringify(tool.function.parameters), /installPath|exePath|savePath|notes/i);
  }
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

test('bulk update previews the change and only writes after confirmation', async () => {
  const f = fixture();
  await f.execute(call('list_games'));
  const result = await f.execute(call('bulk_update', { ids: [1, 2], status: 'completed', addTags: ['原标签'] }));
  assert.equal(result.updated, 2);
  assert.equal(f.confirmations.length, 1);
  assert.match(f.confirmations[0].title, /批量修改 2 部游戏/);
  assert.deepEqual(f.confirmations[0].items, ['Alpha', 'Beta']);
  assert.deepEqual(f.writes, [{ batch: [1, 2], patch: { status: 'completed', addTagIds: [3] } }]);

  const declined = fixture();
  await declined.execute(call('list_games'));
  declined.setConfirm(false);
  const cancelled = await declined.execute(call('bulk_update', { ids: [1], favorite: true }));
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(declined.writes, []);
});

test('bulk update rejects forged ids, unknown tags and contradictory tag edits', async () => {
  const f = fixture();
  await assert.rejects(f.execute(call('bulk_update', { ids: [1], status: 'completed' })), /先查询/);
  await f.execute(call('list_games'));
  await assert.rejects(f.execute(call('bulk_update', { ids: [1, 99], status: 'completed' })), /查询结果/);
  await assert.rejects(f.execute(call('bulk_update', { ids: [1], addTags: ['不存在的标签'] })), /create_tag/);
  await assert.rejects(f.execute(call('bulk_update', { ids: [1], addTags: ['原标签'], removeTags: ['原标签'] })), /同时/);
  await assert.rejects(f.execute(call('bulk_update', { ids: [1] })), /没有需要修改的内容/);
  assert.deepEqual(f.writes, []);
});

test('metadata search previews candidates and apply_metadata confirms the written fields', async () => {
  const f = fixture();
  await f.execute(call('list_games'));
  const search = await f.execute(call('search_metadata', { query: 'Alpha' }));
  assert.equal(search.candidates.length, 1);
  assert.equal(search.candidates[0].externalId, 'v1');
  assert.equal(search.candidates[0].provider, 'vndb');

  const applied = await f.execute(call('apply_metadata', { id: 1, provider: 'vndb', externalId: 'v1', fields: ['title', 'developer'] }));
  assert.equal(applied.applied, true);
  assert.equal(applied.title, 'Alpha');
  assert.match(f.confirmations.at(-1).title, /把资料写入「Alpha」/);
  assert.deepEqual(f.confirmations.at(-1).items, ['标题', '开发商']);
  assert.deepEqual(f.writes.at(-1), { apply: 1, fields: ['title', 'developer'], tagMode: 'merge' });

  await assert.rejects(f.execute(call('apply_metadata', { id: 1, provider: 'vndb', externalId: 'v1', fields: ['bangumi_id'] })), /没有这些字段/);
  await assert.rejects(f.execute(call('apply_metadata', { id: 1, provider: 'evil', externalId: 'v1' })), /资料源无效/);
});

test('apply_metadata without explicit fields writes every populated field', async () => {
  const f = fixture();
  await f.execute(call('list_games'));
  const applied = await f.execute(call('apply_metadata', { id: 1, provider: 'vndb', externalId: 'v1', tagMode: 'replace' }));
  assert.deepEqual(applied.fields, ['title', 'original_title', 'developer', 'release_date', 'description', 'rating', 'tags']);
  assert.deepEqual(f.writes.at(-1), { apply: 1, fields: applied.fields, tagMode: 'replace' });
});

test('folder management lists freely but every mutation needs confirmation', async () => {
  const f = fixture();
  const listed = await f.execute(call('manage_folder', { action: 'list' }));
  assert.deepEqual(listed.folders, [{ id: 'folder-a', name: '已有文件夹', parentId: null, gameCount: 1 }]);
  assert.equal(f.confirmations.length, 0);

  await f.execute(call('list_games'));
  await f.execute(call('manage_folder', { action: 'create', name: '新文件夹' }));
  assert.equal(f.confirmations.at(-1).title, '创建文件夹「新文件夹」？');
  assert.deepEqual(f.getFolders().map(folder => folder.name), ['已有文件夹', '新文件夹']);

  await f.execute(call('manage_folder', { action: 'assign', folderId: 'folder-a', ids: [2] }));
  assert.match(f.confirmations.at(-1).title, /把 1 部游戏加入「已有文件夹」/);
  assert.deepEqual(f.getFolders()[0].gameIds, [1, 2]);

  await f.execute(call('manage_folder', { action: 'unassign', folderId: 'folder-a', ids: [1] }));
  assert.deepEqual(f.getFolders()[0].gameIds, [2]);

  await assert.rejects(f.execute(call('manage_folder', { action: 'rename', folderId: 'missing', name: 'x' })), /文件夹不存在/);
  await assert.rejects(f.execute(call('manage_folder', { action: 'assign', folderId: 'folder-a', ids: [99] })), /查询结果/);
});

test('folder deletion keeps games and a failed save reports a retryable error', async () => {
  const f = fixture();
  await f.execute(call('manage_folder', { action: 'delete', folderId: 'folder-a' }));
  assert.match(f.confirmations.at(-1).detail, /不会删除游戏/);
  assert.deepEqual(f.getFolders(), []);

  const failing = fixture();
  failing.deps.saveFolders = async () => false;
  const result = await failing.execute(call('manage_folder', { action: 'create', name: '另一个' }));
  assert.equal(result.error, '保存文件夹失败，请稍后重试');
});

test('create_tag reuses an existing name and confirms before creating a new one', async () => {
  const f = fixture();
  const reused = await f.execute(call('create_tag', { name: ' 原标签 ' }));
  assert.deepEqual(reused, { created: false, reused: true, tag: '原标签', id: 3 });
  assert.equal(f.confirmations.length, 0);

  const created = await f.execute(call('create_tag', { name: '新标签', color: '#ff8800' }));
  assert.deepEqual(created, { created: true, tag: '新标签', id: 9 });
  assert.equal(f.confirmations.at(-1).title, '创建标签「新标签」？');
  assert.deepEqual(f.writes, [{ tag: '新标签', color: '#ff8800' }]);

  const declined = fixture(); declined.setConfirm(false);
  const cancelled = await declined.execute(call('create_tag', { name: '不建' }));
  assert.equal(cancelled.cancelled, true);
  assert.deepEqual(declined.writes, []);
});

test('new tools reject unsupported arguments and multi-line names', async () => {
  const f = fixture();
  await assert.rejects(f.execute(call('bulk_update', { ids: [1], status: 'completed', notes: 'x' })), /不支持的参数/);
  await assert.rejects(f.execute(call('manage_folder', { action: 'list', path: 'C:/x' })), /不支持的参数/);
  await assert.rejects(f.execute(call('create_tag', { name: '换\n行' })), /name/);
  await assert.rejects(f.execute(call('search_metadata', { query: 'x', sources: ['evil'] })), /资料源参数无效/);
  await f.execute(call('list_games'));
  await assert.rejects(f.execute(call('apply_metadata', { id: 1, provider: 'vndb', externalId: 'v1', fields: ['install_path'] })), /字段参数无效/);
});
