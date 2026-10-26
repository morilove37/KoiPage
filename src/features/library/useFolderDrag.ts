import { useEffect, useRef, useState } from 'react';
import type { HTMLAttributes } from 'react';
import { assignFolder, getFolderMode } from './folders';
import type { LibraryFolder } from './folders';
import { moveFolder } from './folder-operations';

type DragItem = {kind:'folder';id:string} | {kind:'games';ids:number[]};
export interface FolderDropProps extends HTMLAttributes<HTMLElement> { 'data-folder-drop'?: string; 'data-drop-position'?: string }

/** Pointer capture keeps internal dragging independent of native archive/file drops. */
export function useFolderDrag({folders,available,busy,scopeKey,commit,onError}: {
  folders:LibraryFolder[];available:ReadonlySet<number>;busy:boolean;
  scopeKey:string;
  commit:(next:LibraryFolder[],message:string)=>Promise<boolean>;onError:(message:string)=>void;
}) {
  const [dragged,setDragged] = useState<DragItem|null>(null);
  const [hint,setHint] = useState<{id:string;position:string;valid:boolean;text:string}|null>(null);
  const pointer=useRef<{item:DragItem;id:number;x:number;y:number;started:boolean;capture:Element;selection:string;cursor:string}|null>(null);
  const suppressClick=useRef(false);
  const releasePointer=()=>{
    const value=pointer.current;
    if(!value)return;
    pointer.current=null;
    if(value.capture.hasPointerCapture(value.id))value.capture.releasePointerCapture(value.id);
    document.body.style.userSelect=value.selection;document.body.style.cursor=value.cursor;
  };
  useEffect(()=>{
    const cancel=()=>{releasePointer();setDragged(null);setHint(null);suppressClick.current=false;};
    window.addEventListener('blur',cancel);
    return()=>{window.removeEventListener('blur',cancel);releasePointer();};
  },[]);
  useEffect(()=>{releasePointer();setDragged(null);setHint(null);suppressClick.current=false;},[scopeKey]);
  useEffect(()=>{
    if(pointer.current&&!pointer.current.capture.isConnected){releasePointer();setDragged(null);setHint(null);suppressClick.current=false;}
  });
  const clear=()=>{releasePointer();setDragged(null);setHint(null);};
  const proposal=(item:DragItem,targetId:string,position:string)=>{
    const target=folders.find(folder=>folder.id===targetId);
    if(!target)throw Error('目标文件夹已不存在。');
    if(item.kind==='games'){
      if(getFolderMode(folders,targetId)==='folders'||getFolderMode(folders,targetId)==='mixed')throw Error('此目录用于收纳子文件夹，不能直接放入游戏。');
      const ids=[...new Set(item.ids)].filter(id=>available.has(id)&&!target.gameIds.includes(id));
      if(!ids.length)throw Error('这些游戏已在此文件夹中，或已不存在。');
      return {next:assignFolder(folders,targetId,ids,true),message:`已将 ${ids.length} 部游戏加入「${target.name}」。`,hint:`松开以加入「${target.name}」`};
    }
    if(item.id===targetId)throw Error('请拖到其他文件夹中间，或它的左右排序边缘。');
    const parent=position==='inside'?targetId:target.parentId;
    const siblings=folders.filter(folder=>folder.parentId===parent&&folder.id!==item.id);
    const before=position==='before'?targetId:position==='after'?siblings[siblings.findIndex(folder=>folder.id===targetId)+1]?.id:undefined;
    return {next:moveFolder(folders,item.id,parent,before),message:`已${position==='inside'?'移动':'排序'}文件夹「${folders.find(folder=>folder.id===item.id)?.name??''}」。`,hint:position==='inside'?`松开以移入「${target.name}」`:`松开放在「${target.name}」${position==='before'?'之前':'之后'}`};
  };
  const pointerTarget=(x:number,y:number,item:DragItem)=>{
    const element=document.elementFromPoint(x,y)?.closest<HTMLElement>('[data-folder-drop]');
    if(!element)return null;
    const rect=element.getBoundingClientRect(),ratio=(x-rect.left)/Math.max(1,rect.width);
    return {id:element.dataset.folderDrop!,position:item.kind==='games'?'inside':ratio<0.28?'before':ratio>0.72?'after':'inside'};
  };
  const sourceProps=(item:DragItem):HTMLAttributes<HTMLElement>=>({
    draggable:false,
    onDragStart:event=>event.preventDefault(),
    onPointerDown:event=>{
      if(busy||event.button!==0||event.pointerType==='touch')return;
      if(item.kind==='games'&&(event.target as Element).closest('button,input,select,textarea'))return;
      const capture=event.target as Element;
      pointer.current={item,id:event.pointerId,x:event.clientX,y:event.clientY,started:false,capture,selection:document.body.style.userSelect,cursor:document.body.style.cursor};
      capture.setPointerCapture(event.pointerId);
    },
    onPointerMove:event=>{
      const value=pointer.current;
      if(!value||value.id!==event.pointerId)return;
      if(!value.started&&Math.hypot(event.clientX-value.x,event.clientY-value.y)<6)return;
      event.preventDefault();
      if(!value.started){value.started=true;suppressClick.current=true;document.body.style.userSelect='none';document.body.style.cursor='grabbing';setDragged(value.item);}
      const target=pointerTarget(event.clientX,event.clientY,value.item);
      if(!target){setHint(null);return;}
      try{const next=proposal(value.item,target.id,target.position);setHint({...target,valid:true,text:next.hint});}
      catch(cause){setHint({...target,valid:false,text:cause instanceof Error?cause.message:String(cause)});}
    },
    onPointerUp:event=>{
      const value=pointer.current;
      if(!value||value.id!==event.pointerId)return;
      const target=value.started?pointerTarget(event.clientX,event.clientY,value.item):null;
      clear();
      if(value.started){event.preventDefault();window.setTimeout(()=>{suppressClick.current=false;},0);}
      if(!target||busy)return;
      try{const next=proposal(value.item,target.id,target.position);void commit(next.next,next.message);}
      catch(cause){onError(cause instanceof Error?cause.message:String(cause));}
    },
    onPointerCancel:()=>{clear();suppressClick.current=false;},
    onLostPointerCapture:event=>{if(pointer.current?.id===event.pointerId){clear();suppressClick.current=false;}},
    onClickCapture:event=>{if(suppressClick.current){event.preventDefault();event.stopPropagation();suppressClick.current=false;}},
  });
  const targetProps=(id:string):FolderDropProps=>({...sourceProps({kind:'folder',id}),
    'data-folder-drop':id,'data-drop-position':hint?.id===id?`${hint.valid?'valid':'invalid'}-${hint.position}`:undefined});
  return {targetProps,gameProps:(ids:number[])=>sourceProps({kind:'games',ids}),
    hint:dragged?(hint?.text??(dragged.kind==='folder'?'拖到文件夹中间移入，拖到左右边缘排序。':'拖到游戏类型的文件夹以加入分类。')):null};
}
