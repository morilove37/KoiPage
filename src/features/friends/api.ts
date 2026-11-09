import {invoke} from '@/lib/logging';
import {initDatabase} from '@/lib/db';
import type {FriendsStatus,Privacy,Snapshot,HideableGame} from './types';
async function call<T>(command:string,args?:Record<string,unknown>):Promise<T>{await initDatabase();return invoke<T>(command,args);}
export const friendsStatus=()=>call<FriendsStatus>('friends_status');
export const friendsLibraryGames=()=>call<HideableGame[]>('friends_library_games');
export const configureFriends=(serverUrl:string,publicKey:string)=>call<FriendsStatus>('friends_configure',{input:{serverUrl,publicKey}});
export const authenticateFriends=(input:{mode:'login'|'register'|'reset';username:string;password:string;nickname?:string;inviteCode?:string;resetCode?:string})=>call<FriendsStatus>('friends_authenticate',{input});
export const logoutFriends=()=>call<FriendsStatus>('friends_logout');
export const friendsSnapshot=(revision:string|null)=>call<Snapshot>('friends_snapshot',{revision});
export const friendsAction=(action:string,target:string|null=null,value:Record<string,unknown>={})=>call<FriendsStatus>('friends_action',{action,target,value});
export const savePrivacy=(input:Privacy)=>call<FriendsStatus>('friends_preferences',{input});
export const changeFriendsPassword=(password:string)=>call<void>('friends_change_password',{password});
