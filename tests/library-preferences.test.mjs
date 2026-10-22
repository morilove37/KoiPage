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
 p = savePreset(p,' 想玩 '); p = parseLibraryPreferences(JSON.stringify(p));
 assert.equal(p.viewMode,'list'); assert.equal(p.presets[0].name,'想玩'); assert.equal(p.presets[0].filters.search,'abc');
 assert.equal(savePreset(p,'想玩').presets.length,1);
 assert.equal(normalizeFilters({status:'invalid'}).status,'');
});
test('bulk actions cannot include hidden selections',()=> {
 assert.deepEqual(visibleSelection(new Set([1,2,9]),[{id:2},{id:3}]),[2]);
});

test('storage restart restores preferences and unavailable storage stays usable', () => {
 const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
 const data = new Map();
 try {
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)}});
  const p = parseLibraryPreferences(JSON.stringify({viewMode:'list',sortKey:'createdAt',sortDirection:'desc',filters:{search:'a',status:'playing',favoriteOnly:true,activeTagIds:[2],developer:'studio'}}));
  writeLibraryPreferences(savePreset(p,'每日'));
  assert.deepEqual(readLibraryPreferences(),savePreset(p,'每日'));
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
