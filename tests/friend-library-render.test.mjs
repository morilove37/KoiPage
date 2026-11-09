import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {StaticRouter} from 'react-router-dom/server.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(new URL('../package.json',import.meta.url));
const viteRequire=createRequire(require.resolve('vite/package.json'));
const {build}=viteRequire('esbuild');
// Exercise the real TSX, without adding a production export for its private card.
const compiled=await build({absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',
  stdin:{contents:"export {default as FriendsPage} from './src/features/friends/FriendsPage'; export {useFriendsStore} from './src/features/friends/store'; export {LibraryCard} from './src/features/friends/FriendProfilePage';",resolveDir:root,loader:'tsx'},
  plugins:[{name:'expose-private-card-for-render',setup(builder){builder.onLoad({filter:/FriendProfilePage\.tsx$/},async({path})=>({contents:`${await readFile(path,'utf8')}\nexport {LibraryCard};`,loader:'tsx'}));}}],
});
const module={exports:{}};
new Function('require','module','exports',compiled.outputFiles[0].text)(require,module,module.exports);
const {FriendsPage,LibraryCard,useFriendsStore}=module.exports;
const config={serverUrl:'https://example.supabase.co',publicKey:'sb_publishable_test',enabled:false,shareGame:false,shareLibrary:false,invisible:false,hiddenGameIds:[]};
const account={id:'alice',username:'alice',nickname:'Alice',avatar:0,friendCode:'CODE'};

function renderFriends(status){
  // Zustand's SSR snapshot reads its initial object; mutate this test bundle's
  // isolated snapshot instead of replacing the actual component or store hook.
  Object.assign(useFriendsStore.getInitialState(),{status,epoch:0,identityPending:false});
  const originalError=console.error;
  // The closed Dialog uses a client-only layout effect. Its known React SSR
  // warning does not affect this static render; keep every other error visible.
  console.error=(...args)=>{if(!String(args[0]).startsWith('Warning: useLayoutEffect does nothing on the server'))originalError(...args);};
  try{return renderToStaticMarkup(React.createElement(StaticRouter,{location:'/friends'},React.createElement(FriendsPage)));}
  finally{console.error=originalError;}
}
const game={key:'one',title:'星空',originalTitle:null,developer:null,status:'completed',rating:8.75,playTimeSeconds:5400,vndbId:null,bangumiId:null,coverUrl:null};

test('logged out friends page keeps unsent library revocation warning visible and asks for login',()=>{
  const html=renderFriends({config,account:null,connected:false,lastError:null,generation:2,librarySyncedAt:null,libraryError:'FRIENDS_NETWORK: revoke pending'});
  assert.equal((html.match(/role="alert"/g)??[]).length,1);
  assert.match(html,/远端收藏可能仍可见/);
  assert.match(html,/重新登录/);
  assert.doesNotMatch(html,/恢复连接后会重试/);
});

test('logged in friends page shows exactly one native library warning',()=>{
  const html=renderFriends({config:{...config,enabled:true},account,connected:false,lastError:null,generation:2,librarySyncedAt:null,libraryError:'FRIENDS_NETWORK: revoke pending'});
  assert.equal((html.match(/role="alert"/g)??[]).length,1);
  assert.match(html,/远端收藏可能仍可见/);
});

test('friend game card preserves hundredths in personal ratings and shows cumulative playtime',()=>{
  const html=renderToStaticMarkup(React.createElement(LibraryCard,{game}));
  assert.match(html,/8\.75 \/ 10/);
  assert.match(html,/1 小时 30 分钟/);
});

test('friend game card distinguishes a zero personal score from an unrated game',()=>{
  const zero=renderToStaticMarkup(React.createElement(LibraryCard,{game:{...game,rating:0}}));
  const unrated=renderToStaticMarkup(React.createElement(LibraryCard,{game:{...game,rating:null}}));
  assert.match(zero,/0\.00 \/ 10/);assert.doesNotMatch(zero,/未评分/);
  assert.match(unrated,/未评分/);assert.doesNotMatch(unrated,/0\.00 \/ 10/);
});
