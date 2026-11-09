import {create} from 'zustand';
import type {FriendsStatus} from './types';
interface State{status:FriendsStatus|null;epoch:number;apply:(value:FriendsStatus,epoch:number)=>void;invalidate:()=>number}
export const useFriendsStore=create<State>((set,get)=>({status:null,epoch:0,
  apply:(status,epoch)=>{if(epoch===get().epoch)set({status});},
  invalidate:()=>{const epoch=get().epoch+1;const status=get().status;set({epoch,status:status?{...status,account:null,connected:false}:null});return epoch;},
}));
