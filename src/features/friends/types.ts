export interface Account { id:string; username:string; nickname:string; avatar:number; friendCode:string }
import type {GameStatus} from '@/types/game';
export interface FriendsConfig {serverUrl:string;publicKey:string;enabled:boolean;shareGame:boolean;shareLibrary:boolean;shareHistory:boolean;invisible:boolean;hiddenGameIds:number[]}
export interface FriendsStatus {config:FriendsConfig;account:Account|null;connected:boolean;lastError:string|null;generation:number;librarySyncedAt?:number|null;libraryError?:string|null;historySyncedAt?:string|null;historyError?:string|null;deletionPending?:boolean}
export interface HideableGame{id:number;title:string;originalTitle:string|null}
export interface CurrentGame {title:string;vndbId:string|null;bangumiId:string|null;startedAt:number}
export interface Friend extends Account {online:boolean;game:CurrentGame|null}
export interface FriendRequest {id:string;user:Account}
export interface FullSnapshot {unchanged:false;revision:string;serverNow:number;me:Account;friends:Friend[];incoming:FriendRequest[];outgoing:FriendRequest[];blocked:Account[]}
export type Snapshot=FullSnapshot|{unchanged:true;revision:string;serverNow:number};
export interface ViewSnapshot extends FullSnapshot {receivedAt:number;stale:boolean}
export interface Privacy {shareGame:boolean;shareLibrary:boolean;shareHistory:boolean;invisible:boolean;hiddenGameIds:number[]}
export interface SharedLibraryGame {key:string;title:string;originalTitle:string|null;developer:string|null;status:GameStatus;rating:number|null;playTimeSeconds:number;vndbId:string|null;bangumiId:string|null;coverUrl:string|null}
export interface FriendProfile {profile:Friend;serverNow:number;libraryShared:boolean;viewerLibraryShared:boolean;self:boolean;syncedAt:number|null;total:number;games:SharedLibraryGame[];pageSize:number;stats:{total:number;completed:number;playTimeSeconds:number}|null}
export interface FriendProfileView extends FriendProfile {receivedAt:number}
export interface ProfileFilters {target:string;query:string;status:GameStatus|null;offset:number}
export type FriendRelation='friend'|'incoming'|'outgoing'|'none'
export interface UserSearchResult {id:string;username:string;nickname:string;avatar:number;friendCode:string;relation:FriendRelation}
export interface HistorySession {key:string;title:string;vndbId:string|null;bangumiId:string|null;startedAt:string;endedAt:string|null;durationSeconds:number}
export interface FriendHistory {enabled:boolean;sessions:HistorySession[]}
export interface CoverStatus {gameId:number;title:string;nsfw:boolean;customCover:boolean;verified:boolean;reviewStatus:'disabled'|'offline'|'unavailable'|'notSubmitted'|'pending'|'approved'|'rejected'}
