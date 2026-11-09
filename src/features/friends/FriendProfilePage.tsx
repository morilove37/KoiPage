import {useEffect,useRef,useState} from 'react';
import {Link,useParams} from 'react-router-dom';
import {Button} from '@/components/ui/button';
import {Card,EmptyState} from '@/components/ui/card';
import {Input} from '@/components/ui/input';
import {Badge} from '@/components/ui/badge';
import {GAME_STATUSES,GAME_STATUS_LABELS,formatPlayTime} from '@/types/game';
import {formatRating} from '@/lib/rating';
import type {GameStatus} from '@/types/game';
import {FriendAvatar} from './FriendAvatar';
import {createProfileController,elapsedSeconds,libraryCoverSource} from './model';
import {friendsProfile,friendsStatus} from './api';
import {useFriendsStore} from './store';
import type {FriendProfileView,SharedLibraryGame} from './types';

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

function LibraryCard({game}:{game:SharedLibraryGame}){
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
      </div>
    </div>
  </Card>;
}

export default function FriendProfilePage(){
  const {id=''}=useParams<{id:string}>();
  const status=useFriendsStore(state=>state.status),epoch=useFriendsStore(state=>state.epoch);
  const account=status?.account;
  const [search,setSearch]=useState('');
  const [filter,setFilter]=useState<{query:string;status:GameStatus|null;offset:number}>({query:'',status:null,offset:0});
  const identity=`${status?.config.serverUrl??''}:${account?.id??''}:${epoch}:${id}`;
  const requestKey=`${identity}:${JSON.stringify(filter)}`;
  const [result,setResult]=useState<{key:string;value:FriendProfileView|null}>({key:'',value:null});
  const [failure,setFailure]=useState<{key:string;message:string}>({key:'',message:''});
  const [pending,setPending]=useState<{key:string;loading:boolean}>({key:'',loading:false});
  const [clock,setClock]=useState(Date.now());
  const controller=useRef<ReturnType<typeof createProfileController>|null>(null);
  const view=result.key===requestKey?result.value:null;
  const error=failure.key===requestKey?failure.message:'';
  const loading=Boolean(account)&&(pending.key!==requestKey||pending.loading);

  useEffect(()=>{
    const timer=window.setTimeout(()=>setFilter(current=>current.query===search.trim()?current:{...current,query:search.trim(),offset:0}),300);
    return()=>window.clearTimeout(timer);
  },[search]);

  useEffect(()=>{
    if(!account||!id)return;
    let alive=true;
    const next=createProfileController({
      load:friendsProfile,
      onChange:value=>{if(alive){setResult({key:requestKey,value});if(value)setFailure({key:requestKey,message:''});}},
      onLoading:value=>{if(alive)setPending({key:requestKey,loading:value});},
      onError:cause=>{if(alive){setFailure({key:requestKey,message:profileError(cause)});const state=useFriendsStore.getState(),currentEpoch=state.epoch;void friendsStatus().then(value=>{if(alive)state.apply(value,currentEpoch);}).catch(()=>{});}},
    });
    controller.current=next;
    const refresh=()=>{if(document.visibilityState!=='hidden')void next.refresh({target:id,...filter});};
    refresh();
    const timer=window.setInterval(refresh,15000);
    window.addEventListener('focus',refresh);document.addEventListener('visibilitychange',refresh);
    return()=>{alive=false;window.clearInterval(timer);window.removeEventListener('focus',refresh);document.removeEventListener('visibilitychange',refresh);next.reset();if(controller.current===next)controller.current=null;};
  },[identity,requestKey,account?.id,id,filter.query,filter.status,filter.offset]);

  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  useEffect(()=>{if(view&&view.libraryShared&&filter.offset>0&&filter.offset>=view.total)setFilter(current=>({...current,offset:0}));},[view?.total,view?.libraryShared,filter.offset]);

  const refresh=()=>void controller.current?.refresh({target:id,...filter});
  const playing=view?.profile.online?view.profile.game:null;
  const pageSize=view?.pageSize??24;
  return <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <Link to="/friends" className="rounded-md text-sm text-muted-foreground transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">← 返回好友列表</Link>
      <Button size="sm" variant="outline" disabled={!account||loading} onClick={refresh}>{loading?'更新中…':'刷新主页'}</Button>
    </div>
    {!status?<p role="status" className="py-12 text-center text-sm text-muted-foreground">正在读取登录状态…</p>:!account?<EmptyState title="登录后查看好友主页" description="返回好友列表登录，即可浏览好友公开的收藏。" action={<Link to="/friends" className="text-sm text-primary hover:underline">前往登录</Link>}/>:error?<div role="alert"><EmptyState title="好友主页暂时不可用" description={error} action={<Button size="sm" variant="outline" disabled={loading} onClick={refresh}>重新读取</Button>}/></div>:null}
    {account&&!error&&view?<>
      <Card className="overflow-hidden">
        <div className="h-12 border-b border-primary/10 bg-primary/5 sm:h-16" aria-hidden="true"/>
        <div className="flex flex-wrap items-start gap-4 p-5 sm:p-6">
          <div className="-mt-12 rounded-2xl border-4 border-card bg-card"><FriendAvatar user={view.profile} large/></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2"><h1 className="break-words text-xl font-semibold">{view.profile.nickname}</h1><Badge variant="secondary">好友主页</Badge></div>
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
    {account&&!error?<section key="library" aria-labelledby="friend-library-heading" className="space-y-4">
        <div className="flex flex-wrap items-end justify-between gap-2"><h2 id="friend-library-heading" className="text-lg font-semibold">公开游戏库</h2>{view?.libraryShared?<p className="text-xs text-muted-foreground">最后同步：{syncTime(view.syncedAt)}</p>:null}</div>
        <div className={view&&!view.libraryShared?'hidden':'space-y-4'}>
          <Input aria-label="搜索好友的游戏库" placeholder="搜索作品名称或原名" maxLength={100} value={search} onChange={event=>setSearch(event.target.value)}/>
          <div className="flex flex-wrap gap-2" role="group" aria-label="按游玩状态筛选">{[null,...GAME_STATUSES].map(item=><Button key={item??'all'} size="sm" variant={filter.status===item?'default':'outline'} aria-pressed={filter.status===item} onClick={()=>setFilter(current=>({...current,status:item,offset:0}))}>{item===null?'全部':GAME_STATUS_LABELS[item]}</Button>)}</div>
        </div>
        {!view?<p role="status" className="rounded-lg border border-dashed border-border p-12 text-center text-sm text-muted-foreground">正在读取好友主页…</p>:!view.libraryShared?<EmptyState title="对方尚未公开游戏库" description="对方开启分享后，可以在这里查看作品、个人评分和累计游玩时长。"/>:<>
          <p className="text-xs text-muted-foreground" role="status">{filter.query||filter.status?'符合条件的作品':'公开作品'}共 {view.total} 部{loading?' · 正在更新…':''}</p>
          {view.games.length?<div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{view.games.map(game=><LibraryCard key={game.key} game={game}/>)}</div>:<EmptyState title={filter.query||filter.status?'没有找到符合条件的作品':'公开游戏库暂时为空'} description={filter.query||filter.status?'试试其他关键词或游玩状态。':'对方同步收藏后，作品会显示在这里。'}/>}
          {view.total>pageSize?<nav aria-label="好友游戏库分页" className="flex flex-wrap items-center justify-center gap-4 pt-2"><Button size="sm" variant="outline" disabled={loading||filter.offset===0} onClick={()=>setFilter(current=>({...current,offset:Math.max(0,current.offset-pageSize)}))}>上一页</Button><span className="text-xs tabular-nums text-muted-foreground">第 {Math.floor(filter.offset/pageSize)+1} / {Math.ceil(view.total/pageSize)} 页</span><Button size="sm" variant="outline" disabled={loading||filter.offset+pageSize>=view.total} onClick={()=>setFilter(current=>({...current,offset:current.offset+pageSize}))}>下一页</Button></nav>:null}
        </>}
      </section>:null}
  </div>;
}
