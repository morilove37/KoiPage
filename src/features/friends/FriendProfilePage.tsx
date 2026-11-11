import {useEffect,useRef,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {Button} from '@/components/ui/button';
import {Card,EmptyState} from '@/components/ui/card';
import {Input} from '@/components/ui/input';
import {Badge} from '@/components/ui/badge';
import {GAME_STATUSES,GAME_STATUS_LABELS,formatPlayTime} from '@/types/game';
import {formatRating} from '@/lib/rating';
import type {GameStatus} from '@/types/game';
import {errorMessage} from '@/features/io/io';
import {FriendAvatar} from './FriendAvatar';
import {createProfileController,elapsedSeconds,libraryCoverSource,loadHistoryLibrary} from './model';
import {ProfilePlayHistory} from './ProfilePlayHistory';
import {friendsHistory,friendsProfile,friendsReport,friendsStatus} from './api';
import type {ReportReason} from './api';
import {ReportDialog} from './ReportDialog';
import {useFriendsStore} from './store';
import type {FriendHistory,FriendProfileView,SharedLibraryGame} from './types';

function syncTime(value:number|null){
  if(value===null||!Number.isFinite(value))return '尚未同步';
  return new Date(value*1000).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
}

function profileError(error:unknown){
  const message=String(error);
  if(message.includes('FRIENDS_SESSION'))return '登录已失效，请返回好友列表重新登录。';
  if(message.includes('FRIENDS_UNAVAILABLE'))return '暂时无法查看此主页，好友关系或查看权限可能已发生变化。';
  if(message.includes('FRIENDS_NETWORK'))return '连接中断，暂时无法读取好友资料。恢复网络后可刷新重试。';
  return '暂时无法读取好友主页，请稍后刷新重试。';
}

function LibraryCard({game,onReport}:{game:SharedLibraryGame;onReport?:(game:SharedLibraryGame)=>void}){
  const [failed,setFailed]=useState(false);
  const cover=libraryCoverSource(game.coverUrl);
  useEffect(()=>setFailed(false),[cover]);
  return <Card className="flex min-w-0 overflow-hidden">
    <div className="relative flex w-24 shrink-0 items-center justify-center bg-muted sm:w-28">
      {cover&&!failed?<img src={cover} alt="" loading="lazy" decoding="async" onError={()=>setFailed(true)} className="absolute inset-0 size-full object-cover"/>:<span aria-hidden="true" className="px-3 text-center text-xs leading-relaxed text-muted-foreground">暂无封面</span>}
    </div>
    <div className="flex min-w-0 flex-1 flex-col gap-2 p-4">
      <h3 className="break-words text-sm font-semibold leading-relaxed">{game.title}</h3>
      {game.originalTitle&&game.originalTitle!==game.title?<p className="truncate text-xs text-muted-foreground" title={game.originalTitle}>{game.originalTitle}</p>:null}
      {game.developer?<p className="truncate text-xs text-muted-foreground" title={game.developer}>{game.developer}</p>:null}
      <div><Badge variant="secondary">{GAME_STATUS_LABELS[game.status]}</Badge></div>
      <div className="mt-auto space-y-1 pt-1 text-xs text-muted-foreground">
        <p>个人评分 <span className={game.rating===null?'':'font-medium tabular-nums text-foreground'}>{game.rating===null?'未评分':`${formatRating(game.rating)} / 10`}</span></p>
        <p>累计游玩 <span className="tabular-nums text-foreground">{formatPlayTime(game.playTimeSeconds)}</span></p>
        {onReport?<p className="pt-1"><button type="button" className="rounded text-xs text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={()=>onReport(game)}>举报封面</button></p>:null}
      </div>
    </div>
  </Card>;
}

interface ReportTarget {id:string;username:string;nickname:string;gameKey:string|null;defaultReason:ReportReason}

export default function FriendProfilePage(){
  const {id}=useParams<{id?:string}>();
  const status=useFriendsStore(state=>state.status),epoch=useFriendsStore(state=>state.epoch);
  const account=status?.account;
  // `/friends/me` is a static route, so `id` is undefined there; also accept a literal "me".
  const mine=id===undefined||id==='me';
  const target=mine?account?.id??'':id;
  const [search,setSearch]=useState('');
  const [filter,setFilter]=useState<{query:string;status:GameStatus|null;offset:number}>({query:'',status:null,offset:0});
  const identity=`${status?.config.serverUrl??''}:${account?.id??''}:${epoch}:${target}`;
  const requestKey=`${identity}:${JSON.stringify(filter)}`;
  const [result,setResult]=useState<{key:string;value:FriendProfileView|null}>({key:'',value:null});
  const [failure,setFailure]=useState<{key:string;message:string}>({key:'',message:''});
  const [pending,setPending]=useState<{key:string;loading:boolean}>({key:'',loading:false});
  const [history,setHistory]=useState<{key:string;value:FriendHistory|null;error:string}>({key:'',value:null,error:''});
  const [historyAttempt,setHistoryAttempt]=useState(0);
  const [historyLibrary,setHistoryLibrary]=useState<{key:string;games:SharedLibraryGame[]}>({key:'',games:[]});
  const [historyAccess,setHistoryAccess]=useState<{key:string;allowed:boolean;self:boolean}>({key:'',allowed:false,self:false});
  const [reportTarget,setReportTarget]=useState<ReportTarget|null>(null);
  const [reporting,setReporting]=useState(false);
  const [notice,setNotice]=useState(''),[reportError,setReportError]=useState('');
  const [clock,setClock]=useState(Date.now());
  const controller=useRef<ReturnType<typeof createProfileController>|null>(null);
  const view=result.key===requestKey?result.value:null;
  const error=failure.key===requestKey?failure.message:'';
  const loading=Boolean(account)&&(pending.key!==requestKey||pending.loading);
  const historyValue=history.key===identity?history.value:null;
  const historyError=history.key===identity?history.error:'';
  const isSelf=mine||view?.self===true;
  const gated=view?.viewerLibraryShared===false&&!isSelf;

  useEffect(()=>{
    const timer=window.setTimeout(()=>setFilter(current=>current.query===search.trim()?current:{...current,query:search.trim(),offset:0}),300);
    return()=>window.clearTimeout(timer);
  },[search]);

  useEffect(()=>{
    if(!account||!target)return;
    let alive=true;
    const next=createProfileController({
      load:friendsProfile,
      onChange:value=>{if(alive){
        setResult({key:requestKey,value});
        if(value){
          setFailure({key:requestKey,message:''});
          setHistoryAccess({key:identity,allowed:value.libraryShared&&(value.self||value.viewerLibraryShared),self:value.self});
        }
      }},
      onLoading:value=>{if(alive)setPending({key:requestKey,loading:value});},
      onError:cause=>{if(alive){setFailure({key:requestKey,message:profileError(cause)});const state=useFriendsStore.getState(),currentEpoch=state.epoch;void friendsStatus().then(value=>{if(alive)state.apply(value,currentEpoch);}).catch(()=>{});}},
    });
    controller.current=next;
    const refresh=()=>{if(document.visibilityState!=='hidden')void next.refresh({target,...filter});};
    refresh();
    const timer=window.setInterval(refresh,15000);
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{alive=false;window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);next.reset();if(controller.current===next)controller.current=null;};
  },[identity,requestKey,account?.id,target,filter.query,filter.status,filter.offset]);

  useEffect(()=>{
    if(!account||!target)return;
    let alive=true,pending=false;
    const load=()=>{
      if(pending)return;
      pending=true;
      const covers=loadHistoryLibrary(target,friendsProfile,()=>alive)
        .then(games=>{if(alive)setHistoryLibrary({key:identity,games});})
        .catch(()=>{if(alive)setHistoryLibrary({key:identity,games:[]});});
      const records=friendsHistory({target,days:7})
        .then(value=>{if(alive)setHistory({key:identity,value,error:''});})
        .catch(cause=>{if(alive)setHistory({key:identity,value:null,error:profileError(cause)});});
      void Promise.all([covers,records]).finally(()=>{pending=false;});
    };
    load();
    const timer=window.setInterval(()=>{if(document.visibilityState!=='hidden')load();},60000);
    return()=>{alive=false;window.clearInterval(timer);};
  },[identity,account?.id,target,historyAttempt]);

  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  useEffect(()=>{if(view&&view.libraryShared&&filter.offset>0&&filter.offset>=view.total)setFilter(current=>({...current,offset:0}));},[view?.total,view?.libraryShared,filter.offset]);

  const refresh=()=>{void controller.current?.refresh({target,...filter});setHistoryAttempt(value=>value+1);};
  const playing=view?.profile.online?view.profile.game:null;
  const pageSize=view?.pageSize??24;
  const submitReport=(input:{reason:ReportReason;detail:string})=>{
    if(!reportTarget||reporting)return;
    const source=reportTarget;setReporting(true);setReportError('');
    void friendsReport({target:source.id,gameKey:source.gameKey,reason:input.reason,detail:input.detail||null}).then(result=>{
      setNotice(result.duplicate?'已存在相同举报，管理员会一并处理。':'举报已提交，管理员会尽快处理。');
      setReportTarget(null);
    }).catch(cause=>setReportError(errorMessage(cause))).finally(()=>setReporting(false));
  };
  return <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Link to="/friends" className="rounded-md text-sm text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">← 返回好友列表</Link>
      <Button size="sm" variant="outline" disabled={!account||loading} onClick={refresh}>{loading?'更新中…':'刷新主页'}</Button>
    </div>
    {notice?<p role="status" className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">{notice}</p>:null}
    {reportError?<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{reportError}</p>:null}
    {!status?<p role="status" className="py-12 text-center text-sm text-muted-foreground">正在读取登录状态…</p>:!account?<EmptyState title="登录后查看好友主页" description="返回好友列表登录，即可浏览好友公开的收藏。" action={<Link to="/friends" className="text-sm text-primary hover:underline">前往登录</Link>}/>:error?<div role="alert"><EmptyState title="好友主页暂时不可用" description={error} action={<Button size="sm" variant="outline" disabled={loading} onClick={refresh}>重新读取</Button>}/></div>:null}
    {account&&!error&&view?<>
      <Card className="overflow-hidden">
        <div className="h-12 border-b border-primary/10 bg-primary/5 sm:h-16" aria-hidden="true"/>
        <div className="flex flex-wrap items-start gap-4 p-5 sm:p-6">
          <div className="-mt-12 rounded-2xl border-4 border-card bg-card"><FriendAvatar user={view.profile} large/></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h1 className="break-words text-xl font-semibold">{view.profile.nickname}</h1><Badge variant="secondary">{isSelf?'我的主页':'好友主页'}</Badge></div>
            <p className="mt-1 truncate text-xs text-muted-foreground">@{view.profile.username}</p>
            <div className="mt-3 flex items-center gap-2 text-sm"><span aria-hidden="true" className={`size-2 rounded-full ${view.profile.online?'bg-primary':'bg-muted-foreground/50'}`}/><span>{view.profile.online?playing?'正在游玩':'在线':'离线'}</span></div>
            {playing?<div className="mt-2 space-y-1"><p className="break-words text-sm font-medium text-primary">{playing.title}</p><p className="text-xs text-muted-foreground">本次已玩 {formatPlayTime(elapsedSeconds(playing,view,clock))}</p></div>:null}
          </div>
        </div>
      </Card>
      {view.libraryShared&&view.stats?<div className="grid grid-cols-3 gap-3" aria-label="公开游戏库统计">
        <Card className="p-4"><p className="text-xs text-muted-foreground">公开作品</p><p className="mt-2 text-xl font-semibold tabular-nums">{view.stats.total}<span className="ml-1 text-xs font-normal text-muted-foreground">部</span></p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">已通关</p><p className="mt-2 text-xl font-semibold tabular-nums">{view.stats.completed}<span className="ml-1 text-xs font-normal text-muted-foreground">部</span></p></Card>
        <Card className="p-4"><p className="text-xs text-muted-foreground">累计游玩</p><p className="mt-2 break-words text-sm font-semibold tabular-nums sm:text-lg">{formatPlayTime(view.stats.playTimeSeconds)}</p></Card>
      </div>:null}
    </>:null}
    {account&&!error&&historyAccess.key===identity?<ProfilePlayHistory key={identity} history={historyValue} error={historyError} isSelf={mine||historyAccess.self}
      games={historyLibrary.key===identity&&historyAccess.allowed?historyLibrary.games:[]}
      onRetry={()=>setHistoryAttempt(value=>value+1)}/>:null}
    {account&&!error?<section key="library" aria-labelledby="friend-library-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2"><h2 id="friend-library-heading" className="text-lg font-semibold">公开游戏库</h2>{view&&view.libraryShared&&!gated?<p className="text-xs text-muted-foreground">最后同步：{syncTime(view.syncedAt)}</p>:null}</div>
        <div className={view&&(!view.libraryShared||gated)?'hidden':'space-y-4'}>
          <Input aria-label="搜索好友的游戏库" placeholder="搜索作品名称或原名" maxLength={100} value={search} onChange={event=>setSearch(event.target.value)}/>
          <div className="flex flex-wrap gap-2" role="group" aria-label="按游玩状态筛选">{[null,...GAME_STATUSES].map(item=><Button key={item??'all'} size="sm" variant={filter.status===item?'default':'outline'} aria-pressed={filter.status===item} onClick={()=>setFilter(current=>({...current,status:item,offset:0}))}>{item===null?'全部':GAME_STATUS_LABELS[item]}</Button>)}</div>
        </div>
        {!view?<p role="status" className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">正在读取好友主页…</p>:gated?<EmptyState title="需先开启自己的公开游戏库后才能查看他人游戏库" description="为保护双方隐私，只有先开启自己的公开游戏库后，才能查看他人的游戏库。你仍然可以查看对方的在线状态和最近游玩记录。" action={<Link to="/friends" className="text-sm text-primary hover:underline">前往好友页开启公开游戏库</Link>}/>:!view.libraryShared?<EmptyState title={isSelf?'你尚未公开游戏库':'对方尚未公开游戏库'} description={isSelf?'在好友页的「游玩状态与隐私」中开启公开游戏库后，好友才能在这里看到你的收藏。':'对方开启分享后，可以在这里查看作品、个人评分和累计游玩时长。'}/>:<>
          <p className="text-xs text-muted-foreground" role="status">{filter.query||filter.status?'符合条件的作品':'公开作品'}共 {view.total} 部{loading?' · 正在更新…':''}</p>
          {view.games.length?<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{view.games.map(game=><LibraryCard key={game.key} game={game} onReport={isSelf?undefined:()=>setReportTarget({id:view.profile.id,username:view.profile.username,nickname:view.profile.nickname,gameKey:game.key,defaultReason:'cover'})}/>)}</div>:<EmptyState title={filter.query||filter.status?'没有找到符合条件的作品':'公开游戏库暂时为空'} description={filter.query||filter.status?'试试其他关键词或游玩状态。':'对方同步收藏后，作品会显示在这里。'}/>}
          {view.total>pageSize?<nav aria-label="好友游戏库分页" className="flex flex-wrap items-center justify-center gap-4 pt-2"><Button size="sm" variant="outline" disabled={loading||filter.offset===0} onClick={()=>setFilter(current=>({...current,offset:Math.max(0,current.offset-pageSize)}))}>上一页</Button><span className="text-xs tabular-nums text-muted-foreground">第 {Math.floor(filter.offset/pageSize)+1} / {Math.ceil(view.total/pageSize)} 页</span><Button size="sm" variant="outline" disabled={loading||filter.offset+pageSize>=view.total} onClick={()=>setFilter(current=>({...current,offset:current.offset+pageSize}))}>下一页</Button></nav>:null}
        </>}
      </section>:null}
    <ReportDialog open={Boolean(reportTarget)} busy={reporting} defaultReason={reportTarget?.defaultReason??'cover'} target={reportTarget?{username:reportTarget.username,nickname:reportTarget.nickname}:null} onClose={()=>setReportTarget(null)} onSubmit={submitReport}/>
  </div>;
}
