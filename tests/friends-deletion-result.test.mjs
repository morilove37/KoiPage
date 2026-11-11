import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';

async function apiWithReply(reply){
  const source=(await readFile(new URL('../src/features/friends/api.ts',import.meta.url),'utf8'))
    .replace(/import \{invoke\} from [^;]+;/,`const invoke=async()=>(${JSON.stringify(reply)??'undefined'});`)
    .replace(/import \{initDatabase\} from [^;]+;/,'const initDatabase=async()=>{};');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  return import('data:text/javascript;base64,'+Buffer.from(js).toString('base64'));
}

test('frontend never treats partial or malformed deletion replies as completed',async()=>{
  for(const reply of [{ok:true,authDeleted:false,warning:'not deleted'},{ok:true},{ok:false,authDeleted:true},null,{}]){
    const api=await apiWithReply(reply);
    await assert.rejects(api.friendsDeleteAccount(),/注销|删除|确认/);
  }
});

test('confirmed Auth deletion is accepted by the frontend',async()=>{
  const api=await apiWithReply({ok:true,authDeleted:true});
  await api.friendsDeleteAccount();
});
