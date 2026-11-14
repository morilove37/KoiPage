import {invoke} from '@tauri-apps/api/core';
import {observeFriendsActivity} from './polling';
import {useEffect} from 'react';
import {listen} from '@tauri-apps/api/event';
import {friendsStatus} from './api';
import {useFriendsStore} from './store';
import type {FriendsStatus} from './types';
/** Native background runtime owns publication, even while the WebView is hidden. */
export function FriendsRuntime(){useEffect(()=>{
  const stopActivity=observeFriendsActivity(idle=>{void invoke('friends_activity',{idle}).catch(()=>{});});
  let alive=true;let remove:(()=>void)|undefined;
  void listen<FriendsStatus>('friends-status-changed',({payload})=>{if(alive){const state=useFriendsStore.getState();state.apply(payload,state.epoch,true);}}).then(unlisten=>{if(alive)remove=unlisten;else unlisten();}).catch(()=>{});
  const state=useFriendsStore.getState(),epoch=state.epoch;
  void friendsStatus().then(value=>{if(alive)state.apply(value,epoch);}).catch(()=>{});
  return()=>{alive=false;stopActivity();remove?.();};
},[]);return null;}
