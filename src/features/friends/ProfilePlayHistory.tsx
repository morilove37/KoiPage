import {useMemo,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {GeometryIcon} from '@/components/ui/geometry-icon';
import {cn} from '@/lib/utils';
import {formatPlayTime} from '@/types/game';
import {groupHistory,historyCoverSource} from './model';
import type {FriendHistory,SharedLibraryGame} from './types';

const dateTime=(value:string)=>new Date(value).toLocaleString('zh-CN',{year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
const duration=(seconds:number)=>seconds<60?`${Math.max(0,Math.floor(seconds))} 秒`:formatPlayTime(seconds);

function HistoryCover({src}:{src:string|null}){
  const [failed,setFailed]=useState(false);
  return src&&!failed?<img src={src} alt="" loading="lazy" decoding="async" onError={()=>setFailed(true)} className="h-full w-full object-cover"/>:<span aria-hidden="true" className="flex h-full items-center justify-center text-[10px] text-muted-foreground">无封面</span>;
}

export function ProfilePlayHistory({history,error,games,isSelf,onRetry}:{history:FriendHistory|null;error:string;games:SharedLibraryGame[];isSelf:boolean;onRetry:()=>void}){
  const [expanded,setExpanded]=useState(false);
  const [expandedGroups,setExpandedGroups]=useState<Set<string>>(()=>new Set());
  const headerButton=useRef<HTMLButtonElement>(null);
  const groups=useMemo(()=>groupHistory(history?.sessions??[]),[history]);
  return <section aria-labelledby="friend-history-heading" className="min-w-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
    <h2 id="friend-history-heading" className="border-b border-border text-sm font-semibold">
      <button ref={headerButton} type="button" aria-expanded={expanded} aria-controls="friend-history-expanded" aria-label={expanded?'收起全部游玩记录':'展开全部游玩记录'} onClick={()=>setExpanded(value=>!value)}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <span className="flex items-center gap-2"><GeometryIcon name="clock" className="text-primary"/>最近游玩记录</span>
        <span className="flex shrink-0 items-center gap-2 text-xs font-normal text-muted-foreground">
          <span>{!history&&!error?'读取中…':expanded?`共 ${history?.sessions.length??0} 次`:`最近 ${Math.min(3,groups.length)} 款`}</span>
          <span className="text-primary">{expanded?'收起':'查看全部'}</span>
          <svg aria-hidden="true" viewBox="0 0 20 20" className={cn('size-3.5 transition-transform duration-300 motion-reduce:transition-none',expanded&&'rotate-180')}><path d="M5.5 8l4.5 4.5L14.5 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
      </button>
    </h2>
    {error?<div className="space-y-2 px-4 py-4 text-xs"><p role="alert" className="text-destructive">{error}</p><Button size="sm" variant="outline" onClick={onRetry}>重试游玩记录</Button></div>:!history?<p role="status" className="px-4 py-5 text-xs text-muted-foreground">正在读取游玩记录…</p>:!history.enabled?<p className="p-6 text-center text-sm leading-relaxed text-muted-foreground">{isSelf?'你尚未开启游玩记录展示。可在好友页的「游玩状态与隐私」中开启「向好友分享最近游玩记录」。':'对方未开启游玩记录展示。'}</p>:!groups.length?<p className="px-4 py-7 text-center text-sm text-muted-foreground">最近 7 天没有游玩记录。</p>:null}
    <div id="friend-history-expanded">
      {!error&&history?.enabled&&groups.length>0?<div role={expanded?'region':undefined} tabIndex={expanded?0:undefined} aria-label={expanded?'全部游玩记录':undefined}
        className={cn(expanded&&'max-h-96 overflow-y-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring')}>
        <ol className="divide-y divide-border">{(expanded?groups:groups.slice(0,3)).map(group=>{
          const key=group.sessions[0].key,timelineId=`friend-history-timeline-${key}`,open=expandedGroups.has(key);
          const cover=historyCoverSource(group,games);
          return <li key={key} data-history-group={key} className="px-4 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-muted"><HistoryCover key={cover??''} src={cover}/></div>
              <div className="min-w-0 flex-1"><h3 className="truncate text-sm font-medium">{group.title}</h3><p className="mt-1 text-[11px] text-muted-foreground">{group.sessions.length>1?`连续游玩 ${group.sessions.length} 次`:'游玩 1 次'} · 合计 {duration(group.sessions.reduce((sum,session)=>sum+session.durationSeconds,0))}</p></div>
            </div>
            <div className="ml-12 mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
              <p className="text-[11px] text-muted-foreground">最近 <time dateTime={group.sessions[0].startedAt}>{dateTime(group.sessions[0].startedAt)}</time></p>
              <button type="button" aria-expanded={open} aria-controls={timelineId} aria-label={`${open?'收起':'展开'}${group.title}的游玩明细`} onClick={()=>setExpandedGroups(previous=>{const next=new Set(previous);if(next.has(key))next.delete(key);else next.add(key);return next;})}
                className="flex shrink-0 items-center gap-1 rounded px-1 py-1 text-[11px] text-primary hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {open?'收起明细':'游玩明细'}<svg aria-hidden="true" viewBox="0 0 20 20" className={cn('size-3 transition-transform motion-reduce:transition-none',open&&'rotate-180')}><path d="M5.5 8l4.5 4.5L14.5 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </button>
            </div>
            {open?<ol id={timelineId} aria-label={`${group.title}的游玩明细`} tabIndex={0} className="ml-12 mt-2 max-h-48 space-y-1 overflow-y-auto overscroll-contain border-l border-border pl-3 pr-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {group.sessions.map(session=><li key={session.key} data-session-id={session.key} className="flex min-w-0 items-start gap-2"><span aria-hidden="true" className="mt-[5px] size-1.5 shrink-0 rounded-full bg-primary/60"/><p className="min-w-0 flex-1 break-words text-[11px] leading-relaxed text-muted-foreground"><time dateTime={session.startedAt}>{dateTime(session.startedAt)}</time>{session.endedAt?<> → <time dateTime={session.endedAt}>{dateTime(session.endedAt)}</time></>:' · 记录未结束'}</p><p className="shrink-0 text-[11px] font-medium tabular-nums">{session.endedAt?duration(session.durationSeconds):'未结束'}</p></li>)}
            </ol>:null}
          </li>;
        })}</ol>
      </div>:null}
      {expanded&&history?.enabled&&!error?<div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3"><p role="status" className="text-xs text-muted-foreground">最近 7 天 · 显示 {history.sessions.length} 次游玩（最多 200 次）</p><Button size="sm" variant="ghost" onClick={()=>{setExpanded(false);headerButton.current?.focus({preventScroll:true});}}>收起记录</Button></div>:null}
    </div>
  </section>;
}
