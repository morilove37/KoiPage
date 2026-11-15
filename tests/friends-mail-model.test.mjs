import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
const require=createRequire(import.meta.url);
const {build}=createRequire(require.resolve('vite/package.json'))('esbuild');
const root=fileURLToPath(new URL('../',import.meta.url));
const result=await build({absWorkingDir:root,entryPoints:['src/features/friends/mailbox-model.ts'],bundle:true,write:false,platform:'node',format:'cjs'});
const mod={exports:{}};
new Function('module','exports',result.outputFiles[0].text)(mod,mod.exports);
const {parseMailbox,createMailboxController}=mod.exports;
const message={id:'one',kind:'announcement',title:'通知',body:'<script>保留纯文本</script>',createdAt:'2026-11-14T00:00:00Z',readAt:null};
const box={items:[message],unread:1,total:1,hasMore:false};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('mail parser rejects failed or malformed service responses instead of showing an empty inbox',()=>{
  assert.deepEqual(parseMailbox(box),box);
  for(const bad of [null,{}, {error:'FRIENDS_SESSION'}, {...box,items:[{...message,body:undefined}]}, {...box,unread:-1}])assert.throws(()=>parseMailbox(bad),/邮件/);
});

test('destroying an account mailbox suppresses late data and errors',async()=>{
  const pending=deferred(),changes=[];
  const controller=createMailboxController({load:()=>pending.promise,onChange:s=>changes.push(s)});
  const refresh=controller.refresh();controller.destroy();const before=changes.length;
  pending.resolve(box);await refresh;assert.equal(changes.length,before);
  const pendingError=deferred();const second=createMailboxController({load:()=>pendingError.promise.then(()=>{throw Error('旧账号错误');}),onChange:s=>changes.push(s)});
  const retry=second.refresh();second.destroy();const count=changes.length;pendingError.resolve();await retry;
  assert.equal(changes.length,count);
});

test('pending reads cannot be overwritten by a concurrent poll and failed reads preserve unread counts',async()=>{
  const pending=deferred(),calls=[],states=[];
  const controller=createMailboxController({load:async input=>{calls.push(input);if(input.action==='read')return pending.promise;return box;},onChange:s=>states.push(s)});
  await controller.refresh();
  const read=controller.read('one');await controller.refresh();assert.equal(calls.length,2);
  pending.resolve({...box,unread:0,items:[{...message,readAt:'2026-11-14T01:00:00Z'}]});await read;
  assert.equal(states.at(-1).mailbox.unread,0);
  const failed=[];const c=createMailboxController({load:async input=>{if(input.action==='read_all')throw Error('连接中断');return box;},onChange:s=>failed.push(s)});
  await c.refresh();assert.equal(await c.readAll(),false);assert.equal(failed.at(-1).mailbox.unread,1);assert.match(failed.at(-1).error,/连接中断/);
});

test('filters and pages are passed to the server, all-read is global, and refresh retains the current page',async()=>{
  const calls=[],states=[];const controller=createMailboxController({load:async input=>{calls.push(input);return box;},onChange:s=>states.push(s)});
  await controller.navigate(30,'report');await controller.refresh();await controller.readAll();
  assert.deepEqual(calls,[{action:'list',id:null,offset:30,filter:'report'},{action:'list',id:null,offset:30,filter:'report'},{action:'read_all',id:null,offset:30,filter:'report'}]);
  assert.equal(states.at(-1).filter,'report');assert.equal(states.at(-1).offset,30);
});
