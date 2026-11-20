import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLibraryPreferences, normalizeFilters, savePreset, visibleSelection, readLibraryPreferences, writeLibraryPreferences } from '../src/features/library/preferences.ts';
test('corrupt and malicious persisted state falls back safely', () => {
 for (const raw of [null, '{', 'null', '[]']) assert.equal(parseLibraryPreferences(raw).sortKey, 'title');
 const p = parseLibraryPreferences(JSON.stringify({sortKey:'createdAt', viewMode:'bad', filters:{favoriteOnly:'false', activeTagIds:[1,1,-2,'3']}}));
 assert.equal(p.sortKey, 'createdAt'); assert.equal(p.viewMode,'grid');
 assert.deepEqual(p.filters.activeTagIds,[1]); assert.equal(p.filters.favoriteOnly,false);
});
test('view, sorting, filters and named presets survive serialization', () => {
 let p = parseLibraryPreferences(JSON.stringify({viewMode:'list',sortKey:'createdAt',sortDirection:'desc',filters:{search:'abc',status:'playing',activeTagIds:[2]}}));
 // The pre-multi-select string shape migrates to a one-item list.
 assert.deepEqual(p.filters.status,['playing']);
 p = savePreset(p,' 想玩 '); p = parseLibraryPreferences(JSON.stringify(p));
 assert.equal(p.viewMode,'list'); assert.equal(p.presets[0].name,'想玩'); assert.equal(p.presets[0].filters.search,'abc');
 assert.equal(savePreset(p,'想玩').presets.length,1);
 assert.deepEqual(normalizeFilters({status:'invalid'}).status,[]);
});
test('status and developer filters accept arrays, drop invalid items and dedupe', () => {
 assert.deepEqual(normalizeFilters({status:['playing','completed']}).status,['playing','completed']);
 assert.deepEqual(normalizeFilters({status:['playing','invented','completed']}).status,['playing','completed']);
 assert.deepEqual(normalizeFilters({status:['playing','playing']}).status,['playing']);
 assert.deepEqual(normalizeFilters({status:['',42,null]}).status,[]);
 assert.deepEqual(normalizeFilters({status:[]}).status,[]);
 assert.deepEqual(normalizeFilters({developer:['studio','Key']}).developer,['studio','Key']);
 assert.deepEqual(normalizeFilters({developer:['studio','studio','',null,7]}).developer,['studio']);
 assert.deepEqual(normalizeFilters({developer:'studio'}).developer,['studio']);
 assert.deepEqual(normalizeFilters({developer:''}).developer,[]);
 // An empty list is "no filter", not "match nothing".
 assert.deepEqual(normalizeFilters({}).status,[]); assert.deepEqual(normalizeFilters({}).developer,[]);
});
test('developer sort key is persisted and invalid sort keys still fall back', () => {
 assert.equal(parseLibraryPreferences(JSON.stringify({sortKey:'developer'})).sortKey,'developer');
 assert.equal(normalizeFilters({}).developer.length,0);
});
test('bulk actions cannot include hidden selections',()=> {
 assert.deepEqual(visibleSelection(new Set([1,2,9]),[{id:2},{id:3}]),[2]);
});

test('storage restart restores preferences and unavailable storage stays usable', () => {
 const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
 const data = new Map();
 try {
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}});
  // Written by an older build: `status` / `developer` are plain strings there.
  const p = parseLibraryPreferences(JSON.stringify({viewMode:'list',sortKey:'createdAt',sortDirection:'desc',filters:{search:'a',status:'playing',favoriteOnly:true,activeTagIds:[2],developer:'studio'}}));
  writeLibraryPreferences(savePreset(p,'每日'));
  assert.deepEqual(readLibraryPreferences(),savePreset(p,'每日'));
  assert.deepEqual(readLibraryPreferences().filters.status,['playing']);
  assert.deepEqual(readLibraryPreferences().filters.developer,['studio']);
  Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('denied')}});
  assert.doesNotThrow(()=>writeLibraryPreferences(p));
  assert.equal(readLibraryPreferences().viewMode,'grid');
 } finally {
  if (descriptor) Object.defineProperty(globalThis,'localStorage',descriptor);
  else delete globalThis.localStorage;
 }
});

test('installation filter defaults safely and survives named preset storage', () => {
 assert.equal(normalizeFilters({}).installation, 'all');
 assert.equal(normalizeFilters({installation:'invalid'}).installation, 'all');
 let p = parseLibraryPreferences(JSON.stringify({filters:{installation:'archived'}}));
 p = savePreset(p,'已卸载');
 assert.equal(parseLibraryPreferences(JSON.stringify(p)).presets[0].filters.installation,'archived');
 assert.equal(normalizeFilters({installation:'installed'}).installation,'installed');
});
