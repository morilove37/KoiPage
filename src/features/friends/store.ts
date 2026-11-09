import {create} from 'zustand';
import type {FriendsStatus} from './types';
interface State{status:FriendsStatus|null;epoch:number;identityPending:boolean;apply:(value:FriendsStatus,epoch:number,fromEvent?:boolean)=>void;invalidate:()=>number}
export const useFriendsStore=create<State>((set,get)=>({status:null,epoch:0,identityPending:false,
  apply:(status,epoch,fromEvent=false)=>{const state=get();if(epoch===state.epoch&&!(fromEvent&&state.identityPending)&&status.generation>=(state.status?.generation??-1))set({status,...(!fromEvent?{identityPending:false}:{})});},
  invalidate:()=>{const epoch=get().epoch+1;const status=get().status;set({epoch,identityPending:true,status:status?{...status,account:null,connected:false}:null});return epoch;},
}));
