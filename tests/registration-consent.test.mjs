import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {rawMarkdown} from './helpers/raw-markdown.mjs';

const require=createRequire(new URL('../package.json',import.meta.url));
const viteRequire=createRequire(require.resolve('vite/package.json'));
const {build}=viteRequire('esbuild');
const root=fileURLToPath(new URL('../',import.meta.url));
const bundle=await build({absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',packages:'external',
  stdin:{contents:"export * from './src/features/legal/consent'; export * from './src/features/legal/RegistrationConsent'; export * from './src/features/legal/documents';",resolveDir:root,loader:'tsx'},plugins:[rawMarkdown]});
const module={exports:{}};new Function('require','module','exports',bundle.outputFiles[0].text)(require,module,module.exports);
const {emptyRegistrationConsent,isRegistrationConsentValid,isPolicyService,RegistrationConsent,LEGAL_DOCUMENTS,POLICY}=module.exports;

function render(value,serverUrl=POLICY.serverUrl){
  const original=console.error;console.error=(...args)=>{if(!String(args[0]).startsWith('Warning: useLayoutEffect does nothing on the server'))original(...args);};
  try{return renderToStaticMarkup(React.createElement(RegistrationConsent,{value,onChange:()=>{},serverUrl,disabled:false}));}
  finally{console.error=original;}
}

test('registration begins with separate unchecked required consent controls and readable documents',()=>{
  const value=emptyRegistrationConsent(),html=render(value);
  assert.equal(isRegistrationConsentValid(value),false);
  assert.equal((html.match(/type="checkbox"/g)??[]).length,2);
  assert.equal((html.match(/required=""/g)??[]).length,2);
  assert.doesNotMatch(html,/checked=""/);
  assert.match(html,/服务协议/);assert.match(html,/隐私政策/);assert.match(html,/出境告知/);
  assert.doesNotMatch(html,/好友账号连接开发者自托管|提供者：|隐私、删除及注销申请：/);
});

test('all consent values must be exact booleans and match the displayed version',()=>{
  const valid={version:POLICY.version,termsAccepted:true,privacyAccepted:true,crossBorderAccepted:true};
  assert.equal(isRegistrationConsentValid(valid),true);
  for(const key of ['termsAccepted','privacyAccepted','crossBorderAccepted']){
    for(const invalid of [false,'true',1,undefined])assert.equal(isRegistrationConsentValid({...valid,[key]:invalid}),false);
  }
  assert.equal(isRegistrationConsentValid({...valid,version:'old'}),false);
  assert.equal(isRegistrationConsentValid(null),false);
  assert.equal(emptyRegistrationConsent().termsAccepted,false);
});

test('a custom service cannot inherit consent to the official Hong Kong service',()=>{
  assert.equal(isPolicyService(POLICY.serverUrl+'/'),true);
  assert.equal(isPolicyService('https://another.supabase.co'),false);
  const html=render(emptyRegistrationConsent(),'https://another.supabase.co');
  assert.match(html,/当前连接不是/);assert.match(html,/<fieldset disabled=""/);
});

test('the four offline documents name the approved contact and track the shared version',async()=>{
  assert.deepEqual(Object.keys(LEGAL_DOCUMENTS).sort(),['privacy','terms','crossBorder','thirdParties'].sort());
  for(const document of Object.values(LEGAL_DOCUMENTS)){
    assert(document.content.includes(POLICY.version));assert(document.content.includes(POLICY.contactEmail));
    assert(!document.content.includes('待填写'));
  }
  const privacy=LEGAL_DOCUMENTS.privacy.content;
  assert.match(privacy,/不会在账号删除时自动释放/);
  assert.match(LEGAL_DOCUMENTS.crossBorder.content,/雨云/);
  assert.match(LEGAL_DOCUMENTS.crossBorder.content,/中国香港/);
  assert.match(LEGAL_DOCUMENTS.crossBorder.content,/不再通过 Workers/);
});
