export interface Account { id:string; username:string; nickname:string; avatar:number; friendCode:string }
export interface FriendsConfig {serverUrl:string;publicKey:string;enabled:boolean;shareGame:boolean;invisible:boolean;hiddenGameIds:number[]}
export interface FriendsStatus {config:FriendsConfig;account:Account|null;connected:boolean;lastError:string|null;generation:number}
export interface HideableGame{id:number;title:string;originalTitle:string|null}
export interface CurrentGame {title:string;vndbId:string|null;bangumiId:string|null;startedAt:number}
export interface Friend extends Account {online:boolean;game:CurrentGame|null}
export interface FriendRequest {id:string;user:Account}
export interface FullSnapshot {unchanged:false;revision:string;serverNow:number;me:Account;friends:Friend[];incoming:FriendRequest[];outgoing:FriendRequest[];blocked:Account[]}
export type Snapshot=FullSnapshot|{unchanged:true;revision:string;serverNow:number};
export interface ViewSnapshot extends FullSnapshot {receivedAt:number;stale:boolean}
export interface Privacy {shareGame:boolean;invisible:boolean;hiddenGameIds:number[]}
