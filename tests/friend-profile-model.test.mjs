import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/features/friends/model.ts';

const profile={id:'friend-a',username:'alice',nickname:'Alice',avatar:0,friendCode:'CODE',online:false,game:null};
const first={profile,serverNow:1000,libraryShared:true,syncedAt:990,total:1,games:[{key:'one',title:'星空',rating:0,playTimeSeconds:3600}],pageSize:24,stats:{total:1,completed:0,playTimeSeconds:3600}};
const input={target:'friend-a',query:'',status:null,offset:0};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};

test('sharing the library requires a separate explicit boolean opt-in',()=>{
  assert.equal(model.normalizePrivacy({shareGame:true}).shareLibrary,false);
  assert.equal(model.normalizePrivacy({shareLibrary:'true'}).shareLibrary,false);
  assert.equal(model.normalizePrivacy({shareLibrary:true}).shareLibrary,true);
});

test('profile request completed after account/route reset cannot repopulate private data',async()=>{
  const pending=deferred(),changes=[];
  const controller=model.createProfileController({load:()=>pending.promise,onChange:v=>changes.push(v),onError:()=>{},now:()=>10000});
  const request=controller.refresh(input);controller.reset();pending.resolve(first);await request;
  assert.equal(changes.at(-1),null);
  assert.equal(changes.some(v=>v?.games?.length),false);
});

test('older search response cannot overwrite a newer profile page',async()=>{
  const earlier=deferred(),later=deferred(),changes=[];
  const controller=model.createProfileController({load:filter=>filter.query==='星'?earlier.promise:later.promise,onChange:v=>changes.push(v),onError:()=>{},now:()=>10000});
  const a=controller.refresh({...input,query:'星'});
  const b=controller.refresh({...input,query:'月'});
  later.resolve({...first,games:[{key:'two',title:'月光',rating:null,playTimeSeconds:0}]});await b;
  earlier.resolve(first);await a;
  assert.equal(changes.at(-1).games[0].title,'月光');
});

test('revocation and network failure both remove the last successfully read library',async()=>{
  for(const message of ['FRIENDS_UNAVAILABLE','FRIENDS_NETWORK: offline']){
    let failure=false;const changes=[],errors=[];
    const controller=model.createProfileController({load:async()=>{if(failure)throw Error(message);return first;},onChange:v=>changes.push(v),onError:e=>errors.push(e),now:()=>10000});
    await controller.refresh(input);assert.equal(changes.at(-1).games[0].rating,0);
    failure=true;await controller.refresh(input);
    assert.equal(changes.at(-1),null);assert.equal(errors.length,1);
  }
});

test('changing profile filters clears the previous page before the new request completes',async()=>{
  const pending=deferred();let calls=0;const changes=[];
  const controller=model.createProfileController({load:()=>++calls===1?Promise.resolve(first):pending.promise,onChange:v=>changes.push(v),onError:()=>{},now:()=>10000});
  await controller.refresh(input);const request=controller.refresh({...input,offset:24});
  assert.equal(changes.at(-1),null);
  pending.resolve({...first,total:25,games:[]});await request;
  assert.deepEqual(changes.at(-1).games,[]);
});

test('friend library cover accepts only bounded JPEG thumbnails, never local paths or remote URLs',()=>{
  assert.equal(model.libraryCoverSource('data:image/jpeg;base64,/9j/2Q=='),'data:image/jpeg;base64,/9j/2Q==');
  for(const value of ['C:\\private\\cover.png','https://example.com/track.jpg','data:image/svg+xml;base64,abc','data:image/jpeg;base64,%%%',`data:image/jpeg;base64,${'a'.repeat(12288)}`,null])assert.equal(model.libraryCoverSource(value),null);
});
