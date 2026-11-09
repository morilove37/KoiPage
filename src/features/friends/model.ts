import type {CurrentGame,Friend,Privacy,Snapshot,ViewSnapshot} from './types';

export function normalizePrivacy(value:unknown):Privacy{
  const v=value&&typeof value==='object'?value as Record<string,unknown>:{};
  return{shareGame:v.shareGame===true,invisible:v.invisible===true,hiddenGameIds:Array.isArray(v.hiddenGameIds)?[...new Set(v.hiddenGameIds.filter((n):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0))]:[]};
}
export function mergeSnapshot(current:ViewSnapshot|null,next:Snapshot,receivedAt:number):ViewSnapshot|null{
  if(next.unchanged)return current?{...current,serverNow:next.serverNow,receivedAt,stale:false}:null;
  return{...next,receivedAt,stale:false};
}
export function elapsedSeconds(game:CurrentGame,view:ViewSnapshot,at=Date.now()):number{
  const elapsed=view.serverNow-game.startedAt+Math.max(0,at-view.receivedAt)/1000;
  return Number.isFinite(elapsed)?Math.max(0,Math.floor(elapsed)):0;
}
export function sortFriends(friends:readonly Friend[]):Friend[]{
  const rank=(f:Friend)=>f.online?(f.game?2:1):0;
  return [...friends].sort((a,b)=>rank(b)-rank(a)||a.nickname.localeCompare(b.nickname,'zh-CN')||a.id.localeCompare(b.id));
}
export function createSnapshotController(deps:{load:(revision:string|null)=>Promise<Snapshot>;onChange:(value:ViewSnapshot|null)=>void;onError:(error:unknown)=>void;now?:()=>number}){
  let view:ViewSnapshot|null=null,epoch=0,pending:Promise<void>|undefined;
  const now=deps.now??Date.now;
  function reset(){epoch++;view=null;pending=undefined;deps.onChange(null);}
  function refresh():Promise<void>{
    if(pending)return pending;
    const generation=epoch;
    const request=(async()=>{
      try{const next=await deps.load(view?.revision??null);if(generation!==epoch)return;view=mergeSnapshot(view,next,now());deps.onChange(view);}
      catch(error){if(generation!==epoch)return;if(String(error).includes('FRIENDS_SESSION')){view=null;}else if(view){view={...view,stale:true};}deps.onChange(view);deps.onError(error);}
    })().finally(()=>{if(pending===request)pending=undefined;});
    pending=request;return request;
  }
  return{refresh,reset};
}
