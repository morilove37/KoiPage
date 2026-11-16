import {useEffect,useState,useRef} from 'react';
import {friendsMailbox} from './api';
import {clearMailboxCache,createMailboxController,emptyMailboxState,getCachedMailbox,setCachedMailboxSelection} from './mailbox-model';
import {startFriendsPolling} from './polling';
import type {MailboxState} from './mailbox-model';
import type {MailFilter} from './types';

export function useMailbox(accountId:string|undefined){
  const [owned,setOwned]=useState<{owner:string|undefined;state:MailboxState}>(()=>({owner:accountId,state:accountId?getCachedMailbox(accountId).state:emptyMailboxState()}));
  const controller=useRef<ReturnType<typeof createMailboxController>|null>(null);
  const previousAccount=useRef(accountId);
  useEffect(()=>{
    if(!accountId&&previousAccount.current)clearMailboxCache(previousAccount.current);
    previousAccount.current=accountId;
    setOwned({owner:accountId,state:accountId?getCachedMailbox(accountId).state:emptyMailboxState()});
    if(!accountId)return;
    const next=createMailboxController({accountId,load:input=>friendsMailbox(input.action,input.id,input.offset,input.filter),onChange:state=>setOwned({owner:accountId,state})});
    controller.current=next;
    void next.refresh();
    const stop=startFriendsPolling(()=>next.refresh().then(()=>{}),60_000);
    return()=>{next.destroy();stop();if(controller.current===next)controller.current=null;};
  },[accountId]);
  return {...(owned.owner===accountId?owned.state:emptyMailboxState()),accountId,selectedId:accountId?getCachedMailbox(accountId).selectedId:null,select:(id:string|null)=>{if(accountId)setCachedMailboxSelection(accountId,id);},refresh:()=>controller.current?.refresh(),navigate:(offset:number,filter:MailFilter)=>controller.current?.navigate(offset,filter),read:(id:string)=>controller.current?.read(id),readAll:()=>controller.current?.readAll()};
}
