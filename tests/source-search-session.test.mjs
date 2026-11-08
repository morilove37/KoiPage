import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSourceSearchSession } from '../src/features/metadata/source-search-session.ts';

function deferred() { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; }
const candidate = (provider, id, title) => ({provider,externalId:id,title,originalTitle:null,aliases:[],releaseDate:null,coverUrl:null,rating:null,sourceLabel:provider});
const result = (candidates=[],errors=[]) => ({candidates,errors,automaticCandidates:[]});
function harness(reconcile) {
  const calls=[]; const states=[];
  const session=createSourceSearchSession((query,sources,onProgress,contextCandidates)=>{
    const pending=deferred(); calls.push({query,sources,onProgress,contextCandidates,...pending}); return pending.promise;
  },state=>states.push(state),()=>1000,reconcile);
  return {session,calls,states};
}

test('fast source candidates are visible while another source is still searching', async () => {
  const {session,calls}=harness();
  const pending=session.search('CLANNAD',['vndb','2dfan']);
  assert.equal(calls.length,1);
  assert.deepEqual(calls[0].sources,['vndb','2dfan']);
  const hit=candidate('2dfan','21','CLANNAD');
  calls[0].onProgress({provider:'2dfan',candidates:[hit],error:null,elapsedMs:180});
  const state=session.getSnapshot();
  assert.equal(state.searching,true);
  assert.deepEqual(state.result.candidates,[hit]);
  assert.equal(state.sources.find(s=>s.provider==='2dfan').phase,'success');
  assert.equal(state.sources.find(s=>s.provider==='vndb').phase,'searching');
  calls[0].resolve(result([candidate('vndb','v4','CLANNAD'),hit])); await pending;
  assert.equal(session.getSnapshot().searching,false);
  assert.deepEqual(session.getSnapshot().result.candidates.map(c=>c.provider),['vndb','2dfan']);
});

test('retry calls only its source and a late original aggregate cannot overwrite the retry', async () => {
  const {session,calls}=harness();
  const first=session.search('CLANNAD',['vndb','2dfan']);
  const web=candidate('2dfan','21','CLANNAD');
  calls[0].onProgress({provider:'vndb',candidates:[],error:'请求超时',elapsedMs:20000});
  calls[0].onProgress({provider:'2dfan',candidates:[web],error:null,elapsedMs:200});
  const retry=session.retry('vndb');
  assert.deepEqual(calls[1].sources,['vndb']);
  assert.equal(calls[1].query,'CLANNAD');
  assert.deepEqual(session.getSnapshot().result.candidates,[web]);
  const api=candidate('vndb','v4','CLANNAD');
  calls[1].resolve(result([api])); await retry;
  calls[0].resolve(result([web],[{provider:'vndb',message:'旧错误'}])); await first;
  assert.deepEqual(session.getSnapshot().result.candidates,[api,web]);
  assert.deepEqual(session.getSnapshot().result.errors,[]);
});

test('new search and close invalidate late events and late final responses', async () => {
  const {session,calls}=harness();
  const old=session.search('CLANNAD',['vndb']);
  const fresh=session.search('AIR',['2dfan']);
  calls[0].onProgress({provider:'vndb',candidates:[candidate('vndb','v4','CLANNAD')],error:null,elapsedMs:50});
  calls[0].resolve(result([candidate('vndb','v4','CLANNAD')])); await old;
  assert.equal(session.getSnapshot().query,'AIR');
  assert.equal(session.getSnapshot().result.candidates.length,0);
  session.cancel();
  calls[1].onProgress({provider:'2dfan',candidates:[candidate('2dfan','1','AIR')],error:null,elapsedMs:50});
  calls[1].resolve(result([candidate('2dfan','1','AIR')])); await fresh;
  assert.equal(session.getSnapshot().result,null);
});

test('a rejected command preserves already delivered candidates and marks only unfinished sources', async () => {
  const {session,calls}=harness();
  const pending=session.search('CLANNAD',['vndb','2dfan']);
  const hit=candidate('2dfan','21','CLANNAD');
  calls[0].onProgress({provider:'2dfan',candidates:[hit],error:null,elapsedMs:200});
  calls[0].reject(new Error('连接中断')); await pending;
  assert.deepEqual(session.getSnapshot().result.candidates,[hit]);
  assert.deepEqual(session.getSnapshot().result.errors,[{provider:'vndb',message:'连接中断'}]);
  assert.equal(session.getSnapshot().searching,false);
});

test('full results enrich streamed candidates and empty results stay distinct from failure', async () => {
  const {session,calls}=harness();
  const pending=session.search('魔女的夜宴',['vndb','2dfan','bangumi']);
  calls[0].onProgress({provider:'2dfan',candidates:[candidate('2dfan','2588','サノバウィッチ')],error:null,elapsedMs:30});
  const enriched={...candidate('2dfan','2588','サノバウィッチ'),aliases:['魔女的夜宴']};
  calls[0].resolve(result([enriched],[{provider:'bangumi',message:'访问验证'}])); await pending;
  assert.deepEqual(session.getSnapshot().result.candidates[0].aliases,['魔女的夜宴']);
  assert.equal(session.getSnapshot().sources.find(s=>s.provider==='vndb').phase,'empty');
  assert.equal(session.getSnapshot().sources.find(s=>s.provider==='bangumi').phase,'error');
  assert.equal(session.getSnapshot().sources.find(s=>s.provider==='2dfan').elapsedMs,30);
});

test('only requested sources are accepted and duplicate retries are suppressed', async () => {
  const {session,calls}=harness();
  const pending=session.search('CLANNAD',['2dfan']);
  calls[0].onProgress({provider:'vndb',candidates:[candidate('vndb','v4','CLANNAD')],error:null,elapsedMs:1});
  await session.retry('vndb'); await session.retry('2dfan');
  assert.equal(calls.length,1);
  assert.equal(session.getSnapshot().result.candidates.length,0);
  calls[0].resolve(result()); await pending;
  const retry=session.retry('2dfan'); await session.retry('2dfan');
  assert.equal(calls.length,2);
  calls[1].resolve(result()); await retry;
});

test('retry enriches other successful sources without requerying them or losing aliases to an old aggregate', async () => {
  const {session,calls}=harness();
  const first=session.search('魔女的夜宴',['vndb','2dfan']);
  const web=candidate('2dfan','2588','サノバウィッチ');
  calls[0].onProgress({provider:'vndb',candidates:[],error:'超时',elapsedMs:20});
  calls[0].onProgress({provider:'2dfan',candidates:[web],error:null,elapsedMs:10});
  const retry=session.retry('vndb');
  assert.deepEqual(calls[1].sources,['vndb']);
  assert.deepEqual(calls[1].contextCandidates,[web]);
  const api=candidate('vndb','v18397','魔女的夜宴');
  const enriched={...web,aliases:['魔女的夜宴']};
  calls[1].resolve(result([api,enriched])); await retry;
  assert.deepEqual(session.getSnapshot().result.candidates.find(c=>c.provider==='2dfan').aliases,['魔女的夜宴']);
  calls[0].resolve(result([web],[{provider:'vndb',message:'旧超时'}])); await first;
  assert.deepEqual(session.getSnapshot().result.candidates.find(c=>c.provider==='2dfan').aliases,['魔女的夜宴']);
  assert.deepEqual(session.getSnapshot().result.errors,[]);
});

test('a source completing during a retry is included in final local identity reconciliation', async () => {
  const web=candidate('2dfan','2588','サノバウィッチ');
  const api=candidate('vndb','v16044','魔女的夜宴');
  const enriched={...web,aliases:['魔女的夜宴']};
  const {session,calls}=harness(async () => result([api,enriched]));
  const first=session.search('魔女的夜宴',['vndb','2dfan']);
  calls[0].onProgress({provider:'2dfan',candidates:[],error:'超时',elapsedMs:10});
  const retry=session.retry('2dfan');
  calls[0].onProgress({provider:'vndb',candidates:[api],error:null,elapsedMs:20});
  calls[0].resolve(result([api],[{provider:'2dfan',message:'旧超时'}])); await first;
  calls[1].resolve(result([web])); await retry;
  assert.equal(calls.length,2,'reconciliation must not issue another source search');
  assert.deepEqual(session.getSnapshot().result.candidates.find(c=>c.provider==='2dfan').aliases,['魔女的夜宴']);
});

test('closing during local reconciliation cannot resurrect the previous search', async () => {
  const merge=deferred(); const started=deferred();
  const {session,calls}=harness(() => { started.resolve(); return merge.promise; });
  const pending=session.search('CLANNAD',['vndb','2dfan']);
  const web=candidate('2dfan','21','CLANNAD');
  calls[0].resolve(result([web]));
  await started.promise;
  session.cancel();
  merge.resolve(result([web])); await pending;
  assert.equal(session.getSnapshot().result,null);
  assert.equal(session.getSnapshot().searching,false);
});
