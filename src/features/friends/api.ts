import {invoke} from '@/lib/logging';
import {initDatabase} from '@/lib/db';
import type {FriendsStatus,Privacy,Snapshot,HideableGame,FriendProfile,ProfileFilters,UserSearchResult,FriendRelation,FriendHistory,HistorySession,CoverStatus} from './types';
import type {RegistrationConsentValue} from '@/features/legal/consent';
async function call<T>(command:string,args?:Record<string,unknown>):Promise<T>{await initDatabase();return invoke<T>(command,args);}
function isRecord(value:unknown):value is Record<string,unknown>{return Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}
function text(value:unknown):string|null{return typeof value==='string'&&value?value:null;}
function number(value:unknown):number|null{return typeof value==='number'&&Number.isFinite(value)?value:null;}
/** SQL may hand Rust an ISO string or an epoch number; never render an unparseable instant. */
function instant(value:unknown):string{return typeof value==='number'&&Number.isFinite(value)?new Date(value>1e12?value:value*1000).toISOString():typeof value==='string'&&value?value:'';}
function relation(value:unknown):FriendRelation{return value==='friend'||value==='incoming'||value==='outgoing'?value:'none';}
function userResult(value:unknown):UserSearchResult|null{
  if(!isRecord(value)||typeof value.id!=='string'||typeof value.username!=='string')return null;
  return{id:value.id,username:value.username,nickname:text(value.nickname)??value.username,avatar:number(value.avatar)??0,friendCode:text(value.friendCode)??'',relation:relation(value.relation)};
}
function historySession(value:unknown):HistorySession|null{
  if(!isRecord(value))return null;
  const key=text(value.key),title=text(value.title);
  if(!key||!title)return null;
  return{key,title,vndbId:text(value.vndbId),bangumiId:text(value.bangumiId),startedAt:instant(value.startedAt),endedAt:instant(value.endedAt)||null,durationSeconds:Math.max(0,Math.floor(number(value.durationSeconds)??0))};
}
function coverStatus(value:unknown):CoverStatus|null{
  if(!isRecord(value)||typeof value.gameId!=='number'||!Number.isFinite(value.gameId))return null;
  const raw=value.reviewStatus;
  const reviewStatus:CoverStatus['reviewStatus']=raw==='disabled'||raw==='pending'||raw==='approved'||raw==='rejected'||raw==='notSubmitted'||raw==='unavailable'?raw:'offline';
  return{gameId:value.gameId,title:text(value.title)??`作品 ${value.gameId}`,nsfw:value.nsfw===true,customCover:value.customCover===true,verified:reviewStatus==='approved'&&value.verified===true,reviewStatus};
}
export const friendsStatus=()=>call<FriendsStatus>('friends_status');
export const friendsLibraryGames=()=>call<HideableGame[]>('friends_library_games');
export const friendsProfile=({target,query,status,offset}:ProfileFilters)=>call<FriendProfile>('friends_profile',{target,query,status,offset});
export const friendsSyncLibrary=()=>call<FriendsStatus>('friends_sync_library');
export const authenticateFriends=(input:{mode:'login'|'register'|'reset';username:string;password:string;nickname?:string;inviteCode?:string;resetCode?:string;consent?:RegistrationConsentValue})=>call<FriendsStatus>('friends_authenticate',{input});
export const logoutFriends=()=>call<FriendsStatus>('friends_logout');
export const friendsSnapshot=(revision:string|null)=>call<Snapshot>('friends_snapshot',{revision});
export const friendsAction=(action:string,target:string|null=null,value:Record<string,unknown>={})=>call<FriendsStatus>('friends_action',{action,target,value});
export const savePrivacy=(input:Privacy)=>call<FriendsStatus>('friends_preferences',{input});
export const changeFriendsPassword=(password:string)=>call<void>('friends_change_password',{password});

/** Username / friend-code lookup. Never add a friend straight from a returned row. */
export async function friendsSearchUsers(query:string):Promise<UserSearchResult[]>{
  const value=await call<unknown>('friends_search_users',{query});
  const list=Array.isArray(value)?value:isRecord(value)&&Array.isArray(value.results)?value.results:[];
  return list.map(userResult).filter((user):user is UserSearchResult=>user!==null);
}
export async function friendsRequestUser(target:string):Promise<{status:string}>{
  const value=await call<unknown>('friends_request_user',{target});
  return{status:isRecord(value)&&typeof value.status==='string'?value.status:'pending'};
}
export type ReportReason='cover'|'content'|'other';
export async function friendsReport(input:{target:string;gameKey?:string|null;reason:ReportReason;detail?:string|null}):Promise<{duplicate:boolean}>{
  const value=await call<unknown>('friends_report',{target:input.target,gameKey:input.gameKey??null,reason:input.reason,detail:input.detail??null});
  return{duplicate:isRecord(value)&&value.duplicate===true};
}
export async function friendsHistory({target,days=7}:{target:string;days?:number}):Promise<FriendHistory>{
  const value=await call<unknown>('friends_history',{target,days});
  const record=isRecord(value)?value:{};
  const sessions=Array.isArray(record.sessions)?record.sessions:[];
  return{enabled:record.enabled===true,sessions:sessions.map(historySession).filter((session):session is HistorySession=>session!==null)};
}
export async function friendsDeleteAccount(expectedAccount?:string):Promise<void>{
  const value=await call<unknown>('friends_delete_account',{expectedAccount:expectedAccount??null});
  if(!isRecord(value)||value.ok!==true||value.authDeleted!==true)throw Error('账号注销尚未确认完成，请保留登录状态并重试。');
}
export async function friendsResumeDeletion(password:string,expectedAccount:string):Promise<void>{
  const value=await call<unknown>('friends_resume_deletion',{password,expectedAccount});
  if(!isRecord(value)||value.ok!==true||value.authDeleted!==true)throw Error('账号注销尚未确认完成，请保留登录状态并重试。');
}
export async function friendsCoverStatus():Promise<CoverStatus[]>{
  const value=await call<unknown>('friends_cover_status');
  const list=Array.isArray(value)?value:isRecord(value)&&Array.isArray(value.games)?value.games:[];
  return list.map(coverStatus).filter((status):status is CoverStatus=>status!==null);
}
export async function friendsVerifyCover(input:{gameId:number;verified:boolean}):Promise<void>{
  await call<unknown>('friends_verify_cover',{gameId:input.gameId,verified:input.verified});
}
