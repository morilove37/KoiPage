import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderStatistics, replaceFolderGames, resetEmptyFolder, moveFolder } from '../src/features/library/folder-operations.ts';

const available = new Set([1,2,3,4]);
test('subtree statistics count existing games once across all descendants', () => {
  const folders=[{id:'a',name:'A',gameIds:[]},{id:'b',name:'B',parentId:'a',gameIds:[1,2,99]},{id:'c',name:'C',parentId:'a',gameIds:[]},{id:'d',name:'D',parentId:'c',gameIds:[2,3]}];
  const stats=folderStatistics(folders,available);
  assert.deepEqual(stats.get('a'),{childCount:2,descendantCount:3,gameCount:3});
  assert.equal(stats.get('c').gameCount,2);
});
test('membership replacement applies adds/removes and preserves unavailable IDs and unrelated folders',()=>{
  const folders=[{id:'a',name:'A',gameIds:[1,2,99],contentMode:'games'},{id:'b',name:'B',gameIds:[4]}];
  const result=replaceFolderGames(folders,'a',[2,3,3],available);
  assert.deepEqual(result.folders[0].gameIds,[99,2,3]);
  assert.equal(result.added,1);assert.equal(result.removed,1);
  assert.deepEqual(result.folders[1],folders[1]);
});
test('reset only empty folders and clear stale references while preserving name and parent',()=>{
  const folders=[{id:'a',name:'A',gameIds:[],contentMode:'folders'},{id:'b',name:'B',parentId:'a',gameIds:[99],contentMode:'games'}];
  assert.throws(()=>resetEmptyFolder(folders,'a',available));
  const next=resetEmptyFolder(folders,'b',available);
  assert.deepEqual(next[1],{id:'b',name:'B',parentId:'a',gameIds:[]});
  assert.throws(()=>resetEmptyFolder([{id:'c',name:'C',gameIds:[1]}],'c',available));
});
test('moving and ordering retain subtree/game data and persist order',()=>{
  const folders=[{id:'a',name:'A',gameIds:[],contentMode:'folders'},{id:'b',name:'B',parentId:'a',gameIds:[1],contentMode:'games'},{id:'c',name:'C',gameIds:[]},{id:'d',name:'D',gameIds:[]}];
  const reordered=moveFolder(folders,'d',undefined,'a');
  assert.deepEqual(reordered.filter(f=>!f.parentId).map(f=>f.id),['d','a','c']);
  const moved=moveFolder(reordered,'a','c');
  assert.equal(moved.find(f=>f.id==='a').parentId,'c');
  assert.deepEqual(moved.find(f=>f.id==='b'),folders[1]);
  assert.equal(moved.find(f=>f.id==='c').contentMode,'folders');
  assert.deepEqual(JSON.parse(JSON.stringify(moved)),moved);
});
test('invalid folder moves never mutate original tree',()=>{
  const folders=[{id:'a',name:'A',gameIds:[]},{id:'b',name:'B',parentId:'a',gameIds:[]},{id:'c',name:'C',gameIds:[1],contentMode:'games'},{id:'d',name:'A',gameIds:[]},{id:'e',name:'A',parentId:'a',gameIds:[]}];
  const before=JSON.stringify(folders);
  for(const [id,parent] of [['a','a'],['a','b'],['a','c'],['b','missing'],['d','a']]) assert.throws(()=>moveFolder(folders,id,parent));
  assert.equal(JSON.stringify(folders),before);
  assert.throws(()=>moveFolder(folders,'b',undefined,'missing'));
});
test('legacy mixed parents allow sorting existing children without accepting new children',()=>{
  const folders=[{id:'p',name:'Legacy',gameIds:[1]},{id:'a',name:'A',parentId:'p',gameIds:[]},{id:'b',name:'B',parentId:'p',gameIds:[]},{id:'c',name:'C',gameIds:[]}];
  const next=moveFolder(folders,'b','p','a');
  assert.deepEqual(next.filter(f=>f.parentId==='p').map(f=>f.id),['b','a']);
  assert.deepEqual(next.find(f=>f.id==='p').gameIds,[1]);
  assert.throws(()=>moveFolder(folders,'c','p'));
});
