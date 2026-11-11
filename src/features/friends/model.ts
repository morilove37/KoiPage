import type {CurrentGame,Friend,HistorySession,Privacy,Snapshot,ViewSnapshot,FriendProfile,FriendProfileView,ProfileFilters} from './types';

export function normalizePrivacy(value:unknown):Privacy{
  const v=value&&typeof value==='object'?value as Record<string,unknown>:{};
  return{shareGame:v.shareGame===true,shareLibrary:v.shareLibrary===true,shareHistory:v.shareHistory===true,invisible:v.invisible===true,hiddenGameIds:Array.isArray(v.hiddenGameIds)?[...new Set(v.hiddenGameIds.filter((n):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0))]:[]};
}

export interface HistoryGroup {title:string;vndbId:string|null;bangumiId:string|null;sessions:HistorySession[]}
/** Sessions arrive newest-first; consecutive sessions of the same work form one card + timeline. */
export function groupHistory(sessions:readonly HistorySession[]):HistoryGroup[]{
  const groups:HistoryGroup[]=[];
  for(const session of sessions){
    const previous=groups[groups.length-1];
    if(previous&&previous.title===session.title&&previous.vndbId===session.vndbId&&previous.bangumiId===session.bangumiId)previous.sessions.push(session);
    else groups.push({title:session.title,vndbId:session.vndbId,bangumiId:session.bangumiId,sessions:[session]});
  }
  return groups;
}
export function mergeSnapshot(current:ViewSnapshot|null,next:Snapshot,receivedAt:number):ViewSnapshot|null{
  if(next.unchanged)return current?{...current,serverNow:next.serverNow,receivedAt,stale:false}:null;
  return{...next,receivedAt,stale:false};
}
export function elapsedSeconds(game:CurrentGame,view:Pick<ViewSnapshot,'serverNow'|'receivedAt'>,at=Date.now()):number{
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

/** Each page/filter request owns its result; stale requests cannot restore a revoked library. */
export function createProfileController(deps:{load:(input:ProfileFilters)=>Promise<FriendProfile>;onChange:(value:FriendProfileView|null)=>void;onError:(error:unknown)=>void;onLoading?:(loading:boolean)=>void;now?:()=>number}){
  let sequence=0,lastInput='';
  function reset(){sequence++;lastInput='';deps.onChange(null);deps.onLoading?.(false);}
  async function refresh(input:ProfileFilters):Promise<void>{
    const request=++sequence,key=JSON.stringify(input);
    if(lastInput!==key){lastInput=key;deps.onChange(null);}
    deps.onLoading?.(true);
    try{
      const next=await deps.load(input);if(request!==sequence)return;
      const publicView=next.libraryShared?next:{...next,games:[],total:0,stats:null,syncedAt:null};
      deps.onChange({...publicView,receivedAt:deps.now?.()??Date.now()});
    }catch(error){
      if(request!==sequence)return;deps.onChange(null);deps.onError(error);
    }finally{if(request===sequence)deps.onLoading?.(false);}
  }
  return{refresh,reset};
}

/** A friend's cover must not make requests to arbitrary servers or open local paths. */
export function libraryCoverSource(value:unknown):string|null{
  return typeof value==='string'&&value.length<=12288&&/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)?value:null;
}
