import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotController, mergeSnapshot, elapsedSeconds, normalizePrivacy, sortFriends } from '../src/features/friends/model.ts';
import {useFriendsStore} from '../src/features/friends/store.ts';

const user={id:'a',username:'alice',nickname:'Alice',avatar:0,friendCode:'ABC'};
const full={unchanged:false,revision:'r1',serverNow:1000,me:user,friends:[{...user,online:true,game:{title:'测试作品',vndbId:null,bangumiId:null,startedAt:900}}],incoming:[],outgoing:[],blocked:[]};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

test('privacy is opt-in and hidden ids are positive, unique integers',()=>{
  assert.deepEqual(normalizePrivacy({shareGame:'true',invisible:1,hiddenGameIds:[2,2,-1,3.5,'7']}),{shareGame:false,shareLibrary:false,invisible:false,hiddenGameIds:[2]});
});
test('conditional snapshots keep data only when a full snapshot already exists',()=>{
  const first=mergeSnapshot(null,full,10000);
  const same=mergeSnapshot(first,{unchanged:true,revision:'r1',serverNow:1005},15000);
  assert.equal(same.friends[0].game.title,'测试作品');assert.equal(same.serverNow,1005);
  assert.equal(mergeSnapshot(null,{unchanged:true,revision:'r1',serverNow:1005},15000),null);
});
test('duration uses server observation time and never counts backwards when local clock changes',()=>{
  const view=mergeSnapshot(null,full,10000);
  assert.equal(elapsedSeconds(view.friends[0].game,view,14000),104);
  assert.equal(elapsedSeconds(view.friends[0].game,view,9000),100);
});
test('a response arriving after logout cannot repopulate the previous friends',async()=>{
  const pending=deferred();const changes=[];
  const controller=createSnapshotController({load:()=>pending.promise,onChange:v=>changes.push(v),onError:()=>{},now:()=>10000});
  const request=controller.refresh();controller.reset();pending.resolve(full);await request;
  assert.deepEqual(changes,[null]);
});
test('authentication failures clear cached game data, while network errors mark it stale',async()=>{
  let response=full,error=null;const changes=[];
  const controller=createSnapshotController({load:async()=>{if(error)throw error;return response;},onChange:v=>changes.push(v),onError:()=>{},now:()=>10000});
  await controller.refresh();error='FRIENDS_NETWORK: offline';await controller.refresh();
  assert.equal(changes.at(-1).stale,true);
  error='FRIENDS_SESSION: expired';await controller.refresh();assert.equal(changes.at(-1),null);
});
test('friends currently playing sort before idle online and offline friends',()=>{
  const list=[{...user,id:'offline',online:false,game:null},{...user,id:'idle',online:true,game:null},{...user,id:'playing',online:true,game:{title:'x',startedAt:1}}];
  assert.deepEqual(sortFriends(list).map(v=>v.id),['playing','idle','offline']);assert.equal(list[0].id,'offline');
});

test('native status events cannot restore identity during logout or regress a newer native generation',()=>{
  useFriendsStore.setState({status:{account:user,generation:1},epoch:0,identityPending:false});
  const epoch=useFriendsStore.getState().invalidate();
  useFriendsStore.getState().apply({account:user,generation:1},epoch,true);
  assert.equal(useFriendsStore.getState().status.account,null);
  useFriendsStore.getState().apply({account:null,generation:2},epoch);
  useFriendsStore.getState().apply({account:user,generation:1},epoch,true);
  assert.equal(useFriendsStore.getState().status.account,null);
});
