import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier,context,next){
 if(context.parentURL?.endsWith('/society-logo-store.ts')&&specifier==='@/lib/logging')return {url:'data:text/javascript,export const invoke=(...args)=>globalThis.logoIPC(...args)',shortCircuit:true};
 return next(specifier,context);
}});
const {loadSocietyLogo,saveSocietyLogo,useSocietyLogoStore}=await import('../src/features/library/society-logo-store.ts');
const image=(path,custom=false)=>({path,custom,source:custom?'custom':'nextmoe',checkedAt:1,retryAfter:100});
test('unknown societies do not request data, concurrent mounts share one request, saved artwork is reused',async()=>{
 let calls=0,finish;globalThis.logoIPC=async()=>{calls++;return new Promise(r=>finish=r)};
 await loadSocietyLogo('');assert.equal(calls,0);
 const a=loadSocietyLogo('Key'),b=loadSocietyLogo('Key');assert.equal(calls,1);finish(image('key.png'));await Promise.all([a,b]);
 assert.equal(useSocietyLogoStore.getState().entries.Key.logo.path,'key.png');await loadSocietyLogo('Key');assert.equal(calls,1);
});
test('an old automatic lookup cannot replace a newer custom logo',async()=>{
 let finish;globalThis.logoIPC=async(command)=>command==='society_logo_get'?new Promise(r=>finish=r):image('custom.png',true);
 const pending=loadSocietyLogo('SMEE');await saveSocietyLogo('SMEE','custom.png');finish(image('old.png'));await pending;
 assert.equal(useSocietyLogoStore.getState().entries.SMEE.logo.path,'custom.png');
});
test('resetting an override performs a fresh lookup and failed manual saves keep the previous artwork',async()=>{
 globalThis.logoIPC=async(command)=>command==='society_logo_set'?image(null):image('auto.png');
 await saveSocietyLogo('SMEE',null);assert.equal(useSocietyLogoStore.getState().entries.SMEE.logo.path,'auto.png');
 globalThis.logoIPC=async()=>{throw new Error('invalid image')};await assert.rejects(saveSocietyLogo('SMEE','bad.png'));
 assert.equal(useSocietyLogoStore.getState().entries.SMEE.logo.path,'auto.png');assert.match(useSocietyLogoStore.getState().entries.SMEE.error,/invalid image/);
});
test('expired negative caches retry on the next visit while current misses avoid new requests',async()=>{
 let calls=0;globalThis.logoIPC=async()=>{calls++;return {...image(null),retryAfter:Math.floor(Date.now()/1000)+900}};
 useSocietyLogoStore.setState(state=>({entries:{...state.entries,Retry:{logo:{...image(null),retryAfter:1},loading:false,saving:false,error:null}}}));
 await loadSocietyLogo('Retry');assert.equal(calls,1);await loadSocietyLogo('Retry');assert.equal(calls,1);
});
test('a rejected custom file does not discard an in-flight automatic result',async()=>{
 let finish;globalThis.logoIPC=async(command)=>{if(command==='society_logo_get')return new Promise(r=>finish=r);throw new Error('invalid file')};
 const pending=loadSocietyLogo('PendingFailure');await assert.rejects(saveSocietyLogo('PendingFailure','bad.png'));finish(image('automatic.png'));await pending;
 assert.equal(useSocietyLogoStore.getState().entries.PendingFailure.logo.path,'automatic.png');
});
