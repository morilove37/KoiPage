import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFolders, createFolder, renameFolder, assignFolder, matchesFolder, groupBySociety, matchesSociety, folderPath, removeFolderTree, getFolderMode, selectFolderMode } from '../src/features/library/folders.ts';

test('folder content choices are exclusive, persistent and retained when emptied', () => {
  let folders = createFolder([], '子文件夹分类', 'a');
  assert.equal(getFolderMode(folders,'a'),null);
  folders = createFolder(folders,'子目录','b','a');
  assert.equal(getFolderMode(folders,'a'),'folders');
  assert.throws(()=>assignFolder(folders,'a',[1],true));
  assert.throws(()=>selectFolderMode(folders,'a','games'));
  folders = removeFolderTree(folders,'b');
  assert.equal(getFolderMode(parseFolders(JSON.stringify(folders)),'a'),'folders');
  folders = createFolder(folders,'直接放游戏','c');
  folders = selectFolderMode(folders,'c','games');
  assert.throws(()=>createFolder(folders,'不应创建','d','c'));
  folders = assignFolder(folders,'c',[1],true);
  folders = assignFolder(folders,'c',[1],false);
  assert.equal(getFolderMode(parseFolders(JSON.stringify(folders)),'c'),'games');
});

test('legacy folders infer content mode without discarding existing data', () => {
  const folders = [{id:'a',name:'父目录',gameIds:[]},{id:'b',name:'游戏',parentId:'a',gameIds:[1]},{id:'c',name:'空目录',gameIds:[]}];
  assert.equal(getFolderMode(folders,'a'),'folders');
  assert.equal(getFolderMode(folders,'b'),'games');
  assert.equal(getFolderMode(folders,'c'),null);
  assert.equal(getFolderMode(assignFolder(folders,'b',[1],false),'b'),'games');
  assert.equal(getFolderMode(removeFolderTree(folders,'b'),'a'),'folders');
});

test('nested folders keep sibling names unique and persist a navigable hierarchy', () => {
  let folders = createFolder([], '收藏', 'a');
  folders = createFolder(folders, '短篇', 'b', 'a');
  folders = createFolder(folders, '短篇', 'c');
  folders = createFolder(folders, '重玩', 'd', 'b');
  assert.throws(() => createFolder(folders, '短篇', 'e', 'a'));
  assert.throws(() => createFolder(folders, '孤儿', 'e', 'missing'));
  assert.deepEqual(folderPath(parseFolders(JSON.stringify(folders)), 'd').map(f => f.id), ['a','b','d']);
  assert.deepEqual(removeFolderTree(folders, 'b').map(f => f.id), ['a','c']);
  assert.equal(renameFolder(folders, 'b', '重命名')[1].parentId, 'a');
});

test('legacy folders remain roots and invalid parent cycles recover without losing games', () => {
  const folders = parseFolders(JSON.stringify([{id:'a',name:'旧分类',gameIds:[1]},{id:'b',name:'子分类',parentId:'missing',gameIds:[2]},{id:'c',name:'循环C',parentId:'d',gameIds:[3]},{id:'d',name:'循环D',parentId:'c',gameIds:[4]}]));
  assert.deepEqual(folders.flatMap(f => f.gameIds),[1,2,3,4]);
  assert.equal(folders[0].parentId,undefined);
  assert.equal(folders[1].parentId,undefined);
  for (const f of folders) assert.ok(folderPath(folders,f.id).length <= folders.length);
});

test('society folders follow developer metadata, trim names and retain unknown games', () => {
  const games = [{id:1,developer:' Makura '},{id:2,developer:'Makura'},{id:3,developer:null},{id:4,developer:'  '},{id:5,developer:'Key'}];
  const groups = groupBySociety(games);
  assert.deepEqual(groups.find(group => group.name === 'Makura').gameIds,[1,2]);
  assert.deepEqual(groups.at(-1), {name:'未知社团',value:'',gameIds:[3,4]});
  assert.equal(groups.reduce((sum,group) => sum + group.gameIds.length, 0), games.length);
  assert.equal(matchesSociety('Makura', games[0]),true);
  assert.equal(matchesSociety('', games[2]),true);
  assert.equal(matchesSociety('Key', games[0]),false);
  assert.deepEqual(groupBySociety([]),[]);
});

test('folders survive serialization and normalize invalid memberships', () => {
  assert.deepEqual(parseFolders('{'), []);
  assert.deepEqual(parseFolders('null'), []);
  const folders = parseFolders(JSON.stringify([{id:'a',name:' 收藏夹 ',gameIds:[1,1,-1,'2']},{id:'a',name:'重复',gameIds:[]}]));
  assert.deepEqual(folders, [{id:'a',name:'收藏夹',gameIds:[1]}]);
  assert.deepEqual(parseFolders(JSON.stringify(folders)), folders);
});

test('create and rename validate names without changing memberships', () => {
  const folders = createFolder([], ' 想玩 ', 'a');
  assert.throws(() => createFolder(folders, '想玩', 'b'));
  assert.throws(() => createFolder(folders, ' ', 'b'));
  assert.equal(renameFolder(folders, 'a', '短篇')[0].name, '短篇');
  assert.deepEqual(folders[0].gameIds, []);
});

test('games may belong to several folders and removal preserves other folders', () => {
  let folders = createFolder(createFolder([], '短篇', 'a'), '想玩', 'b');
  folders = assignFolder(folders, 'a', [1,2,2], true);
  folders = assignFolder(folders, 'b', [1], true);
  assert.equal(matchesFolder(folders, 'a', 1), true);
  assert.equal(matchesFolder(folders, 'unfiled', 3), true);
  assert.equal(matchesFolder(folders, 'unfiled', 1), false);
  folders = assignFolder(folders, 'a', [1], false);
  assert.equal(matchesFolder(folders, 'a', 1), false);
  assert.equal(matchesFolder(folders, 'b', 1), true);
  assert.equal(matchesFolder(folders.filter(f => f.id !== 'b'), 'unfiled', 1), true);
  assert.equal(matchesFolder(folders, '', 1), true);
});
