import {useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '@/components/ui/button';
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {Field,Input} from '@/components/ui/input';
import {Badge} from '@/components/ui/badge';
import {ConfirmDialog} from '@/components/ui/dialog';
import {formatPlayTime} from '@/types/game';
import {writeText} from '@tauri-apps/plugin-clipboard-manager';
import {errorMessage} from '@/features/io/io';
import * as api from './api';
import {createSnapshotController,elapsedSeconds,normalizePrivacy,sortFriends} from './model';
import {useFriendsStore} from './store';
import type {Account,FriendsStatus,ViewSnapshot,HideableGame} from './types';

const AVATARS=['🌸','🍀','🌙','🦊','🐱','🐧','🎮','📖'];
function Avatar({user}:{user:Account}){return <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-2xl">{AVATARS[user.avatar]??AVATARS[0]}</span>;}

export default function FriendsPage(){
  const status=useFriendsStore(s=>s.status),account=status?.account;
  const [view,setView]=useState<ViewSnapshot|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [serverUrl,setServerUrl]=useState(''),[publicKey,setPublicKey]=useState('');
  const [connectionOpen,setConnectionOpen]=useState(false);
  const [mode,setMode]=useState<'login'|'register'|'reset'>('login'),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[inviteCode,setInviteCode]=useState(''),[resetCode,setResetCode]=useState('');
  const [nickname,setNickname]=useState(''),[avatar,setAvatar]=useState(0),[newPassword,setNewPassword]=useState(''),[friendCode,setFriendCode]=useState('');
  const [games,setGames]=useState<HideableGame[]>([]),[query,setQuery]=useState(''),[clock,setClock]=useState(Date.now());
  const [confirm,setConfirm]=useState<{action:'remove'|'block';user:Account}|null>(null);
  const controller=useRef<ReturnType<typeof createSnapshotController>|null>(null);
  const active=useRef(true);
  const refreshStatus=useCallback(async()=>{const state=useFriendsStore.getState(),epoch=state.epoch;const next=await api.friendsStatus();if(active.current)state.apply(next,epoch);return next;},[]);
  useEffect(()=>{active.current=true;void refreshStatus().catch(e=>{if(active.current)setError(errorMessage(e));});return()=>{active.current=false;};},[refreshStatus]);
  useEffect(()=>{let alive=true;setGames([]);if(account)void api.friendsLibraryGames().then(value=>{if(alive)setGames(value);}).catch(()=>{});return()=>{alive=false;};},[account?.id]);
  useEffect(()=>{if(status){setServerUrl(status.config.serverUrl);setPublicKey(status.config.publicKey);}},[status?.config.serverUrl,status?.config.publicKey]);
  useEffect(()=>{setNickname(account?.nickname??'');setAvatar(account?.avatar??0);},[account?.id,account?.nickname,account?.avatar]);
  useEffect(()=>{
    if(!account){setView(null);return;}
    let alive=true;
    const next=createSnapshotController({load:api.friendsSnapshot,onChange:v=>{if(alive){setView(v);if(v&&!v.stale){setError(current=>current.includes('FRIENDS_NETWORK')?'':current);void refreshStatus().catch(()=>{});}}},onError:e=>{if(alive){setError(errorMessage(e));void refreshStatus().catch(()=>{});}}});
    controller.current=next;void next.refresh();
    const timer=window.setInterval(()=>{if(document.visibilityState!=='hidden')void next.refresh();},5000);
    const focus=()=>void next.refresh();window.addEventListener('focus',focus);
    return()=>{alive=false;window.clearInterval(timer);window.removeEventListener('focus',focus);next.reset();if(controller.current===next)controller.current=null;};
  },[account?.id,refreshStatus]);
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  async function perform(action:()=>Promise<FriendsStatus|void>,message='',identity=false){
    if(busy)return;setBusy(true);setError('');setNotice('');
    const state=useFriendsStore.getState(),epoch=identity?state.invalidate():state.epoch;
    if(identity){controller.current?.reset();setView(null);}
    try{const next=await action();if(!active.current)return;if(next)state.apply(next,epoch);setNotice(message);await controller.current?.refresh();}
    catch(e){if(active.current){setError(errorMessage(e));void refreshStatus().catch(()=>{});}}
    finally{if(active.current)setBusy(false);}
  }
  const config=status?.config;
  const privacy=normalizePrivacy(config);
  const togglePrivacy=(patch:Partial<typeof privacy>)=>void perform(()=>api.savePrivacy({...privacy,...patch}),'分享设置已保存。');
  const action=(name:string,target:string,value:Record<string,unknown>={})=>void perform(()=>api.friendsAction(name,target,value),'操作已完成。');
  const selected=games.filter(g=>!query.trim()||`${g.title}\n${g.originalTitle??''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).slice(0,200);
  const friends=sortFriends(view?.friends??[]);
  return <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">好友 <Badge variant="secondary">邀请内测</Badge></h1><p className="mt-1 text-sm text-muted-foreground">看看朋友正在推哪部作品。</p></div>
      <div className="flex items-center gap-2"><Button size="sm" variant="ghost" aria-expanded={connectionOpen} aria-controls="friends-service-connection" onClick={()=>setConnectionOpen(open=>!open)}>连接设置</Button>{account?<Button variant="outline" disabled={busy} onClick={()=>void perform(api.logoutFriends,'已退出登录。',true)}>退出登录</Button>:null}</div></div>
    {error?<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>:null}
    {notice?<p role="status" className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">{notice}</p>:null}
    {connectionOpen?<section id="friends-service-connection" className="rounded-lg border border-border bg-card p-4"><h2 className="text-sm font-medium">内测服务连接{config?.serverUrl?' · 已配置':''}</h2>
      <form className="mt-4 grid gap-3 sm:grid-cols-2" onSubmit={e=>{e.preventDefault();void perform(()=>api.configureFriends(serverUrl,publicKey),'服务地址已保存。',true);}}>
        <Field label="项目地址"><Input value={serverUrl} onChange={e=>setServerUrl(e.target.value)} placeholder="管理员提供的 HTTPS 项目地址" disabled={busy}/></Field>
        <Field label="项目公钥" hint="使用管理员提供的 publishable / anon 公钥。"><Input value={publicKey} onChange={e=>setPublicKey(e.target.value)} placeholder="sb_publishable_…" disabled={busy}/></Field>
        <Button type="submit" disabled={busy||!serverUrl||!publicKey} className="sm:col-span-2 sm:justify-self-start">保存连接</Button>
      </form></section>:null}
    {!status?<p role="status" className="py-8 text-center text-muted-foreground">正在读取内测配置…</p>:!account?<Card><CardHeader><CardTitle>加入恋页好友内测</CardTitle></CardHeader><CardContent>
      <div className="mb-5 flex gap-2">{(['login','register','reset'] as const).map(item=><Button key={item} size="sm" variant={mode===item?'default':'outline'} disabled={busy} onClick={()=>{setMode(item);setPassword('');setError('');}}>{item==='login'?'登录':item==='register'?'邀请码注册':'重置密码'}</Button>)}</div>
      <form className="grid max-w-lg gap-4" onSubmit={e=>{e.preventDefault();const attempt={mode,username,password,nickname,inviteCode,resetCode};setPassword('');setInviteCode('');setResetCode('');void perform(()=>api.authenticateFriends(attempt),mode==='register'?'注册成功，已登录。':'已登录。',true);}}>
        <Field label="用户名" hint="3–32 位字母、数字或下划线。"><Input autoComplete="username" required value={username} onChange={e=>setUsername(e.target.value)} disabled={busy}/></Field>
        {mode==='register'?<><Field label="昵称"><Input value={nickname} maxLength={32} onChange={e=>setNickname(e.target.value)} disabled={busy}/></Field><Field label="邀请码"><Input required autoComplete="off" value={inviteCode} onChange={e=>setInviteCode(e.target.value)} disabled={busy}/></Field></>:null}
        {mode==='reset'?<Field label="管理员提供的重置码"><Input required autoComplete="off" value={resetCode} onChange={e=>setResetCode(e.target.value)} disabled={busy}/></Field>:null}
        <Field label={mode==='reset'?'新密码':'密码'} hint="12–72 位英文字母、数字或符号，不支持中文和空格。"><Input type="password" required minLength={12} maxLength={72} pattern="[!-~]{12,72}" title="请输入 12–72 位英文字母、数字或符号，不支持中文和空格" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete={mode==='login'?'current-password':'new-password'} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></Field>
        <Button type="submit" disabled={busy||!config?.serverUrl}>{busy?'处理中…':mode==='login'?'登录':mode==='register'?'注册并登录':'设置新密码并登录'}</Button>
      </form></CardContent></Card>:<>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
        <Card><CardHeader><CardTitle>我的资料</CardTitle></CardHeader><CardContent className="space-y-4">
          <div className="flex items-center gap-3"><Avatar user={account}/><div className="min-w-0"><p className="font-medium">{account.nickname}</p><p className="text-xs text-muted-foreground">@{account.username} · {config?.invisible?'隐身中':status.connected?'已连接':'状态待更新'}</p></div></div>
          <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">好友码</span><code className="select-all rounded bg-muted px-2 py-1 text-sm">{account.friendCode}</code><Button size="sm" variant="ghost" onClick={()=>void perform(async()=>{await writeText(account.friendCode);},'好友码已复制。')}>复制</Button></div>
          <form className="space-y-3" onSubmit={e=>{e.preventDefault();void perform(()=>api.friendsAction('profile',null,{nickname,avatar}),'个人资料已保存。');}}>
            <Field label="昵称"><Input required value={nickname} maxLength={32} onChange={e=>setNickname(e.target.value)} disabled={busy}/></Field>
            <div className="flex flex-wrap gap-2" role="group" aria-label="选择头像">{AVATARS.map((symbol,index)=><button type="button" key={symbol} aria-pressed={avatar===index} aria-label={`头像 ${index+1}`} disabled={busy} className={`size-10 rounded-lg border text-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${avatar===index?'border-primary bg-primary/10':'border-border'}`} onClick={()=>setAvatar(index)}>{symbol}</button>)}</div>
            <Button type="submit" size="sm" disabled={busy}>保存资料</Button>
          </form>
          <details><summary className="cursor-pointer text-xs text-muted-foreground">修改密码</summary><form className="mt-3 flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();const value=newPassword;setNewPassword('');void perform(()=>api.changeFriendsPassword(value),'密码已更新。');}}><Input type="password" autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} pattern="[!-~]{12,72}" title="请输入 12–72 位英文字母、数字或符号，不支持中文和空格" aria-label="新密码" minLength={12} maxLength={72} required value={newPassword} onChange={e=>setNewPassword(e.target.value)} className="min-w-0 flex-1" disabled={busy}/><Button type="submit" size="sm" disabled={busy}>更新密码</Button></form></details>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>游玩状态与隐私</CardTitle></CardHeader><CardContent className="space-y-4">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={privacy.shareGame} disabled={busy} onChange={e=>togglePrivacy({shareGame:e.target.checked})}/><span>向好友分享正在游玩的游戏<span className="mt-1 block text-xs text-muted-foreground">仅显示恋页启动并跟踪的作品；缩小到托盘后继续更新。</span></span></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={privacy.invisible} disabled={busy} onChange={e=>togglePrivacy({invisible:e.target.checked})}/><span>隐身<span className="mt-1 block text-xs text-muted-foreground">好友会看到你离线，同时隐藏正在游玩的作品。</span></span></label>
          <details><summary className="cursor-pointer text-sm">隐藏指定作品 · 已选 {privacy.hiddenGameIds.length} 部</summary><div className="mt-3 space-y-2"><Input aria-label="搜索要隐藏的作品" placeholder="搜索作品" value={query} onChange={e=>setQuery(e.target.value)}/><div className="max-h-48 space-y-2 overflow-y-auto">{selected.map(game=><label key={game.id} className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-primary" checked={privacy.hiddenGameIds.includes(game.id)} disabled={busy} onChange={e=>togglePrivacy({hiddenGameIds:e.target.checked?[...privacy.hiddenGameIds,game.id]:privacy.hiddenGameIds.filter(id=>id!==game.id)})}/><span className="truncate">{game.title}</span></label>)}</div>{!games.length?<p className="text-xs text-muted-foreground">游戏库中的作品会显示在这里。</p>:null}</div></details>
          <p className="text-xs leading-relaxed text-muted-foreground">每次重新登录默认关闭作品分享。网络中断后，好友看到的在线状态会在超时后失效。</p>
        </CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>添加好友</CardTitle></CardHeader><CardContent><form className="flex max-w-lg gap-2" onSubmit={e=>{e.preventDefault();const code=friendCode;setFriendCode('');action('request',code);}}><Input aria-label="对方的好友码" placeholder="输入对方的完整好友码" value={friendCode} maxLength={32} onChange={e=>setFriendCode(e.target.value)} disabled={busy}/><Button type="submit" disabled={busy||!friendCode.trim()}>发送申请</Button></form></CardContent></Card>
      {(view?.incoming.length||view?.outgoing.length)?<Card><CardHeader><CardTitle>好友申请</CardTitle></CardHeader><CardContent className="space-y-3">
        {view.incoming.map(request=><div key={request.id} className="flex flex-wrap items-center gap-3"><Avatar user={request.user}/><span className="min-w-0 flex-1 truncate text-sm">{request.user.nickname} 想添加你为好友</span><Button size="sm" disabled={busy} onClick={()=>action('accept',request.id)}>同意</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>action('reject',request.id)}>拒绝</Button></div>)}
        {view.outgoing.map(request=><div key={request.id} className="flex items-center gap-3 text-sm"><span className="min-w-0 flex-1 truncate">已向 {request.user.nickname} 发送申请</span><Button size="sm" variant="ghost" disabled={busy} onClick={()=>action('cancel',request.id)}>取消申请</Button></div>)}
      </CardContent></Card>:null}
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">好友列表 <span className="text-sm font-normal text-muted-foreground">{friends.length} 人</span></h2><Button size="sm" variant="outline" disabled={busy} onClick={()=>void controller.current?.refresh()}>刷新</Button></div>
      {view?.stale?<p role="status" className="text-sm text-muted-foreground">连接中断，好友状态待更新。</p>:null}
      {!view?<p role="status" className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{error?'暂时无法获取好友列表，请检查连接后刷新。':'正在获取好友列表…'}</p>:!friends.length?<p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">还没有好友，把你的好友码发给一起推 Galgame 的朋友吧。</p>:<div className="grid gap-3 md:grid-cols-2">{friends.map(friend=><div key={friend.id} className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-4"><Avatar user={friend}/><div className="min-w-0 flex-1"><p className="truncate font-medium">{friend.nickname}</p><p className="mt-1 text-xs text-muted-foreground">{view.stale?'状态待更新':friend.online?friend.game?'正在游玩':'在线':'离线'}</p>{!view.stale&&friend.online&&friend.game?<><p className="mt-2 break-words text-sm font-medium text-primary">{friend.game.title}</p><p className="mt-1 text-xs text-muted-foreground">本次已玩 {formatPlayTime(elapsedSeconds(friend.game,view,clock))}</p></>:null}<div className="mt-3 flex gap-3"><button disabled={busy} className="text-xs text-muted-foreground hover:text-destructive" onClick={()=>setConfirm({action:'remove',user:friend})}>删除好友</button><button disabled={busy} className="text-xs text-muted-foreground hover:text-destructive" onClick={()=>setConfirm({action:'block',user:friend})}>屏蔽</button></div></div></div>)}</div>}
      {view?.blocked.length?<details className="rounded-lg border border-border bg-card p-4"><summary className="cursor-pointer text-sm">已屏蔽 · {view.blocked.length} 人</summary><div className="mt-3 space-y-2">{view.blocked.map(user=><div key={user.id} className="flex items-center justify-between gap-3 text-sm"><span>{user.nickname}</span><Button size="sm" variant="ghost" disabled={busy} onClick={()=>action('unblock',user.id)}>解除屏蔽</Button></div>)}</div></details>:null}
    </>}
    <ConfirmDialog open={Boolean(confirm)} title={confirm?.action==='block'?'屏蔽此用户？':'删除好友？'} description={confirm?`${confirm.user.nickname} 将无法继续查看你的在线和游玩状态。`:''} confirmText={confirm?.action==='block'?'屏蔽':'删除好友'} destructive onCancel={()=>setConfirm(null)} onConfirm={()=>{if(confirm){action(confirm.action,confirm.user.id);setConfirm(null);}}}/>
  </div>;
}
