import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

test('disabled cover status survives IPC normalization and cannot grant local approval',async()=>{
  const reply=[{gameId:1,title:'Custom',customCover:true,verified:true,reviewStatus:'disabled'}];
  const source=(await readFile(new URL('../src/features/friends/api.ts',import.meta.url),'utf8'))
    .replace(/import \{invoke\} from [^;]+;/,`const invoke=async()=>(${JSON.stringify(reply)});`)
    .replace(/import \{initDatabase\} from [^;]+;/,'const initDatabase=async()=>{};');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const api=await import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
  const [status]=await api.friendsCoverStatus();
  assert.equal(status.reviewStatus,'disabled');
  assert.equal(status.verified,false);
});

test('cover status has no cloud review request or implicit library submission in the disabled release',async()=>{
  const source=await readFile(new URL('../src-tauri/src/friends/library.rs',import.meta.url),'utf8');
  const status=source.slice(source.indexOf('pub(super) async fn cover_status('),source.indexOf('pub(super) async fn verify_cover('));
  assert.doesNotMatch(status,/runtime::rpc|sync\(app/);
});
