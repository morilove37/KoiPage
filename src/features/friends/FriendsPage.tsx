import {useCallback,useEffect,useRef,useState} from 'react';
import {Link} from 'react-router-dom';
import {Button} from '@/components/ui/button';
import {Card,CardContent,CardHeader,CardTitle} from '@/components/ui/card';
import {Field,Input} from '@/components/ui/input';
import {Badge} from '@/components/ui/badge';
import {ConfirmDialog} from '@/components/ui/dialog';
import {formatPlayTime} from '@/types/game';
import {writeText} from '@tauri-apps/plugin-clipboard-manager';
import {errorMessage} from '@/features/io/io';
import {LegalDocuments} from '@/features/legal/LegalDocuments';
import {RegistrationConsent} from '@/features/legal/RegistrationConsent';
import {emptyRegistrationConsent,isRegistrationConsentValid,isPolicyService} from '@/features/legal/consent';
import * as api from './api';
import {startFriendsPolling} from './polling';
import {createSnapshotController,elapsedSeconds,normalizePrivacy,sortFriends} from './model';
import {useFriendsStore} from './store';
import {FriendAvatar as Avatar} from './FriendAvatar';
import {avatarPreset} from './avatar-catalog';
import {AvatarPickerDialog} from './AvatarPickerDialog';
import {ReportDialog} from './ReportDialog';
import type {Account,FriendsStatus,ViewSnapshot,HideableGame,UserSearchResult,FriendRelation} from './types';
import type {ReportReason} from './api';

function formatSyncTime(value:string|number|null|undefined):string|null{
  if(value===null||value===undefined||value==='')return null;
  const date=typeof value==='number'?new Date(value*1000):new Date(value);
  return Number.isNaN(date.getTime())?null:date.toLocaleString('zh-CN');
}
function relationLabel(relation:FriendRelation):string{
  return relation==='friend'?'已是好友':relation==='incoming'?'待你处理申请':relation==='outgoing'?'已发送申请':'可添加';
}

interface ReportTarget {id:string;username:string;nickname:string;gameKey:string|null;defaultReason:ReportReason}

export default function FriendsPage(){
  const status=useFriendsStore(s=>s.status),account=status?.account;
  const [view,setView]=useState<ViewSnapshot|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
  const [mode,setMode]=useState<'login'|'register'|'reset'>('login'),[username,setUsername]=useState(''),[password,setPassword]=useState(''),[resetCode,setResetCode]=useState('');
  const [registrationConsent,setRegistrationConsent]=useState(emptyRegistrationConsent);
  const [nickname,setNickname]=useState(''),[avatar,setAvatar]=useState(0),[newPassword,setNewPassword]=useState('');
  const [avatarOpen,setAvatarOpen]=useState(false);
  const [addQuery,setAddQuery]=useState(''),[searching,setSearching]=useState(false),[searchResults,setSearchResults]=useState<UserSearchResult[]|null>(null),[addTarget,setAddTarget]=useState<UserSearchResult|null>(null);
  const [reportTarget,setReportTarget]=useState<ReportTarget|null>(null);
  const [games,setGames]=useState<HideableGame[]>([]),[query,setQuery]=useState(''),[clock,setClock]=useState(Date.now());
  const [friendQuery,setFriendQuery]=useState(''),[onlineOnly,setOnlineOnly]=useState(false);
  const [confirm,setConfirm]=useState<{action:'remove'|'block';user:Account}|null>(null);
  const controller=useRef<ReturnType<typeof createSnapshotController>|null>(null);
  const active=useRef(true);
  const refreshStatus=useCallback(async()=>{const state=useFriendsStore.getState(),epoch=state.epoch;const next=await api.friendsStatus();if(active.current)state.apply(next,epoch);return next;},[]);
  useEffect(()=>{active.current=true;void refreshStatus().catch(e=>{if(active.current)setError(errorMessage(e));});return()=>{active.current=false;};},[refreshStatus]);
  useEffect(()=>{let alive=true;setGames([]);if(account)void api.friendsLibraryGames().then(value=>{if(alive)setGames(value);}).catch(()=>{});return()=>{alive=false;};},[account?.id]);
  useEffect(()=>{setNickname(account?.nickname??'');setAvatar(avatarPreset(account?.avatar??0).id);},[account?.id,account?.nickname,account?.avatar]);
  useEffect(()=>{
    if(!account){setView(null);return;}
    let alive=true;
    const next=createSnapshotController({load:api.friendsSnapshot,onChange:v=>{if(alive){setView(v);if(v&&!v.stale){setError(current=>current.includes('FRIENDS_NETWORK')?'':current);void refreshStatus().catch(()=>{});}}},onError:e=>{if(alive){setError(errorMessage(e));void refreshStatus().catch(()=>{});}}});
    controller.current=next;
    const stopPolling=startFriendsPolling(()=>next.refresh());
    return()=>{alive=false;stopPolling();next.reset();if(controller.current===next)controller.current=null;};
  },[account?.id,refreshStatus]);
  useEffect(()=>{const timer=window.setInterval(()=>setClock(Date.now()),1000);return()=>window.clearInterval(timer);},[]);
  async function perform(action:()=>Promise<FriendsStatus|void>,message='',identity=false,onSuccess?:()=>void){
    if(busy)return;setBusy(true);setError('');setNotice('');
    const state=useFriendsStore.getState(),epoch=identity?state.invalidate():state.epoch;
    if(identity){controller.current?.reset();setView(null);}
    try{const next=await action();if(!active.current)return;if(next)state.apply(next,epoch);if(message)setNotice(message);onSuccess?.();await controller.current?.refresh();}
    catch(e){if(active.current){setError(errorMessage(e));void refreshStatus().catch(()=>{});}}
    finally{if(active.current)setBusy(false);}
  }
  const config=status?.config;
  const requiresConsent=mode==='register'||isPolicyService(config?.serverUrl??'');
  useEffect(()=>{setRegistrationConsent(emptyRegistrationConsent());},[config?.serverUrl]);
  const privacy=normalizePrivacy(config);
  const togglePrivacy=(patch:Partial<typeof privacy>)=>void perform(()=>api.savePrivacy({...privacy,...patch}),'设置已保存在本机，云端同步状态见下方。');
  const action=(name:string,target:string,value:Record<string,unknown>={})=>void perform(async()=>{
    const result=await api.friendsAction(name,target,value);
    if(searchResults!==null&&addQuery.trim()){
      try{setSearchResults(await api.friendsSearchUsers(addQuery.trim()));}catch{setSearchResults(null);}
    }
    return result;
  },'操作已完成。');
  async function searchUsers(){
    const text=addQuery.trim();
    if(!text||searching)return;
    setSearching(true);setError('');setSearchResults(null);
    try{const results=await api.friendsSearchUsers(text);if(active.current)setSearchResults(results);}
    catch(cause){if(active.current)setError(errorMessage(cause));}
    finally{if(active.current)setSearching(false);}
  }
  const requestUser=(user:UserSearchResult)=>void perform(async()=>{
    const result=await api.friendsRequestUser(user.id);
    setAddTarget(null);setSearchResults(null);setAddQuery('');
    setNotice(result.status==='friends'?'你们已经是好友了。':`已向 @${user.username} 发送好友申请。`);
  },'');
  const saveAvatar=(presetId:number)=>void perform(
    ()=>api.friendsAction('profile',null,{nickname:account?.nickname??'',avatar:presetId}),
    '头像已更新。',
    false,
    ()=>setAvatarOpen(false),
  );
  const submitReport=(input:{reason:ReportReason;detail:string})=>{
    if(!reportTarget)return;
    const target=reportTarget;
    void perform(async()=>{
      const result=await api.friendsReport({target:target.id,gameKey:target.gameKey,reason:input.reason,detail:input.detail||null});
      setReportTarget(null);
      setNotice(result.duplicate?'已存在相同举报，管理员会一并处理。':'举报已提交，管理员会尽快处理。');
    },'');
  };
  const matchingGames=games.filter(g=>!query.trim()||`${g.title}\n${g.originalTitle??''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected=matchingGames.slice(0,200);
  const friends=sortFriends(view?.friends??[]);
  const filteredFriends=friends.filter(friend=>(!onlineOnly||friend.online)&&`${friend.nickname}\n${friend.username}`.toLocaleLowerCase().includes(friendQuery.trim().toLocaleLowerCase()));
  const librarySynced=formatSyncTime(status?.librarySyncedAt),historySynced=formatSyncTime(status?.historySyncedAt);
  return <div className="mx-auto flex max-w-6xl flex-col gap-5 p-6">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">好友 <Badge variant="secondary">内测</Badge></h1><p className="mt-1 text-sm text-muted-foreground">看看朋友正在推哪部作品。</p></div>
      <div className="flex items-center gap-2">{account?<Button variant="outline" disabled={busy||status?.deletionPending} onClick={()=>void perform(api.logoutFriends,'已退出登录。',true)}>退出登录</Button>:null}</div></div>
    {!account?<div className="text-xs text-muted-foreground"><LegalDocuments/></div>:null}
    {error?<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p>:null}
    {status?.libraryError?<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm leading-relaxed text-destructive">{account?<>游戏库尚未同步成功。{privacy.shareLibrary?'好友暂时可能看到上次同步的收藏。':'关闭或隐藏操作尚待同步，远端收藏可能仍可见。'}恢复连接后会重试。</>:<>游戏库同步或撤回尚未完成，远端收藏可能仍可见。请恢复网络并重新登录，确认同步结果。</>}</p>:null}
    {!account&&status?.historyError?<p role="alert" className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">游玩记录尚未撤回，远端记录可能仍可见。请恢复网络并重新登录，确认同步结果。</p>:null}
    {status?.deletionPending?<section role="status" className="rounded-lg border border-border bg-muted/40 p-4 text-sm">账号注销结果待确认，好友同步已暂停。<Link to="/settings#settings-account" className="ml-2 text-primary hover:underline">前往确认注销结果</Link></section>:null}
    {account&&status&&!status.connected&&!status.deletionPending?<section role="status" className="rounded-lg border border-border bg-muted/40 p-4 text-sm">
      <p className="font-medium">未连接至服务器，正在重试…</p>
      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">登录状态已保留，恢复网络后会自动重连；下方显示的是上次同步的数据。</p>
      <Button size="sm" variant="outline" className="mt-3" disabled={busy} onClick={()=>void perform(api.friendsStatus)}>刷新连接状态</Button>
    </section>:null}
    {notice?<p role="status" className="rounded-lg border border-primary/20 bg-primary/5 p-3 text-sm">{notice}</p>:null}

    {!status?<p role="status" className="py-8 text-center text-muted-foreground">正在读取内测配置…</p>:!account?<Card><CardHeader><CardTitle>加入恋页好友内测</CardTitle></CardHeader><CardContent>
      <div className="mb-5 flex gap-2">{(['login','register','reset'] as const).map(item=><Button key={item} size="sm" variant={mode===item?'default':'outline'} disabled={busy} onClick={()=>{setMode(item);setPassword('');setRegistrationConsent(emptyRegistrationConsent());setError('');}}>{item==='login'?'登录':item==='register'?'注册':'重置密码'}</Button>)}</div>
      {mode==='register'?<p className="mb-4 max-w-lg text-xs leading-relaxed text-muted-foreground">无需邀请码，每个公网 IP 累计最多注册 5 个账号，注销不会重置名额；提交后若连接中断，可先用原用户名和密码尝试登录。</p>:null}
      <form className="grid max-w-lg gap-4" onSubmit={e=>{e.preventDefault();if(requiresConsent&&(!isRegistrationConsentValid(registrationConsent)||!isPolicyService(config?.serverUrl??''))){setError('请先阅读并同意本服务当前版本的协议、隐私政策和出境告知。');return;}const attempt={mode,username,password,nickname,resetCode,consent:requiresConsent?registrationConsent:undefined};setPassword('');setResetCode('');void perform(()=>api.authenticateFriends(attempt),mode==='register'?'注册成功，已登录。':'已登录。',true);}}>
        <Field label="用户名" hint="3–32 位字母、数字或下划线。"><Input autoComplete="username" required value={username} onChange={e=>setUsername(e.target.value)} disabled={busy}/></Field>
        {mode==='register'?<><Field label="昵称"><Input value={nickname} maxLength={32} onChange={e=>setNickname(e.target.value)} disabled={busy}/></Field></>:null}
        {mode==='reset'?<Field label="管理员提供的重置码"><Input required autoComplete="off" value={resetCode} onChange={e=>setResetCode(e.target.value)} disabled={busy}/></Field>:null}
        <Field label={mode==='reset'?'新密码':'密码'} hint="12–72 位英文字母、数字或符号，不支持中文和空格。"><Input type="password" required minLength={12} maxLength={72} pattern="[!-~]{12,72}" title="请输入 12–72 位英文字母、数字或符号，不支持中文和空格" autoCapitalize="none" autoCorrect="off" spellCheck={false} autoComplete={mode==='login'?'current-password':'new-password'} value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></Field>
        {requiresConsent?<RegistrationConsent value={registrationConsent} onChange={setRegistrationConsent} serverUrl={config?.serverUrl??''} disabled={busy}/>:null}
        <Button type="submit" disabled={busy||!config?.serverUrl||(requiresConsent&&(!isRegistrationConsentValid(registrationConsent)||!isPolicyService(config.serverUrl)))}>{busy?'处理中…':mode==='login'?'登录':mode==='register'?'注册并登录':'设置新密码并登录'}</Button>
      </form></CardContent></Card>:<>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.8fr)]">
        <Card><CardHeader><CardTitle>我的资料</CardTitle></CardHeader><CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Avatar user={account}/>
            <div className="min-w-0 flex-1"><p className="truncate font-medium">{account.nickname} <span className="text-xs font-normal text-muted-foreground">@{account.username}</span></p><p className="truncate text-xs text-muted-foreground">{config?.invisible?'隐身中':status.connected?'已连接':'未连接'}</p></div>
            <div className="flex shrink-0 flex-col items-end gap-1"><Button size="sm" variant="outline" disabled={busy} onClick={()=>setAvatarOpen(true)}>更换头像</Button><Link to="/friends/me" className="rounded text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">查看我的主页</Link></div>
          </div>
          <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-muted-foreground">好友码</span><code className="select-all rounded bg-muted px-2 py-1 text-sm">{account.friendCode}</code><Button size="sm" variant="ghost" onClick={()=>void perform(async()=>{await writeText(account.friendCode);},'好友码已复制。')}>复制</Button></div>
          <form className="space-y-3" onSubmit={e=>{e.preventDefault();void perform(()=>api.friendsAction('profile',null,{nickname,avatar}),'个人资料已保存。');}}>
            <Field label="昵称"><Input required value={nickname} maxLength={32} onChange={e=>setNickname(e.target.value)} disabled={busy}/></Field>
            <p className="text-xs leading-relaxed text-muted-foreground">当前头像：{avatarPreset(avatar).name} · {avatarPreset(avatar).work}。点击上方“更换头像”可挑选其他角色。</p>
            <Button type="submit" size="sm" disabled={busy}>保存资料</Button>
          </form>
          <details><summary className="cursor-pointer text-xs text-muted-foreground">修改密码</summary><form className="mt-3 flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();const value=newPassword;setNewPassword('');void perform(()=>api.changeFriendsPassword(value),'密码已更新。');}}><Input type="password" autoComplete="new-password" autoCapitalize="none" autoCorrect="off" spellCheck={false} pattern="[!-~]{12,72}" title="请输入 12–72 位英文字母、数字或符号，不支持中文和空格" aria-label="新密码" minLength={12} maxLength={72} required value={newPassword} onChange={e=>setNewPassword(e.target.value)} className="min-w-0 flex-1" disabled={busy}/><Button type="submit" size="sm" disabled={busy}>更新密码</Button></form></details>
        </CardContent></Card>
        <Card><CardHeader><CardTitle>游玩状态与隐私</CardTitle></CardHeader><CardContent className="space-y-4">
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={privacy.shareGame} disabled={busy} onChange={e=>togglePrivacy({shareGame:e.target.checked})}/><span>向好友分享正在游玩的游戏<span className="mt-1 block text-xs text-muted-foreground">仅显示恋页启动并跟踪的作品；缩小到托盘后继续更新。</span></span></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={privacy.shareLibrary} disabled={busy} onChange={e=>togglePrivacy({shareLibrary:e.target.checked})}/><span>向好友公开我的游戏库<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">分享作品封面、游玩状态、个人评分与累计时长，离线时好友也能查看最后同步的收藏。</span></span></label>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={privacy.shareHistory} disabled={busy} onChange={e=>togglePrivacy({shareHistory:e.target.checked})}/><span>向好友分享最近游玩记录<span className="mt-1 block text-xs leading-relaxed text-muted-foreground">展示最近 7 天的游玩作品、开始/结束时间与时长。关闭后远端记录会被删除。</span></span></label>
          <div className="space-y-1.5 rounded-md bg-muted/50 p-3">
            <p role="status" className={`text-xs leading-relaxed ${status.libraryError?'text-destructive':'text-muted-foreground'}`}>{status.libraryError?'游戏库同步失败，远端可能仍显示旧内容；恢复连接后会重试。':status.libraryPending?'游戏库设置正在同步，远端可能仍显示旧内容。':privacy.shareLibrary?librarySynced?`游戏库已同步：${librarySynced}`:'游戏库等待首次同步。':status.libraryPending===false?'游戏库分享已关闭，远端已撤回。':'游戏库分享已关闭，远端状态待确认。'}</p>
            <p role="status" className={`text-xs leading-relaxed ${status.historyError?'text-destructive':'text-muted-foreground'}`}>{status.historyError?'游玩记录同步失败，远端可能仍显示旧记录；恢复连接后会重试。':status.historyPending?'游玩记录设置正在同步，远端可能仍显示旧记录。':privacy.shareHistory?historySynced?`游玩记录已同步：${historySynced}`:'游玩记录等待首次同步。':status.historyPending===false?'游玩记录分享已关闭，远端已撤回。':'游玩记录分享已关闭，远端状态待确认。'}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">游戏库和游玩记录会在后台自动同步，无需手动操作。</p>
          </div>
          <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1 accent-primary" checked={privacy.invisible} disabled={busy} onChange={e=>togglePrivacy({invisible:e.target.checked})}/><span>隐身<span className="mt-1 block text-xs text-muted-foreground">好友会看到你离线，同时隐藏正在游玩的作品；已公开的游戏库仍可查看。</span></span></label>
          <details><summary className="cursor-pointer text-sm">隐藏指定作品 · 已选 {privacy.hiddenGameIds.length} 部</summary><div className="mt-3 space-y-2"><Input aria-label="搜索要隐藏的作品" placeholder="搜索作品" value={query} onChange={e=>setQuery(e.target.value)}/><div className="max-h-48 space-y-2 overflow-y-auto">{selected.map(game=><label key={game.id} className="flex items-center gap-2 text-xs"><input type="checkbox" className="accent-primary" checked={privacy.hiddenGameIds.includes(game.id)} disabled={busy} onChange={e=>togglePrivacy({hiddenGameIds:e.target.checked?[...privacy.hiddenGameIds,game.id]:privacy.hiddenGameIds.filter(id=>id!==game.id)})}/><span className="truncate">{game.title}</span></label>)}</div>{matchingGames.length>200?<p role="status" className="text-xs text-muted-foreground">仅显示前 200 部，请继续输入名称缩小范围。</p>:null}{!games.length?<p className="text-xs text-muted-foreground">游戏库中的作品会显示在这里。</p>:null}</div></details>
          <p className="text-xs leading-relaxed text-muted-foreground">隐藏的作品会从正在游玩、公开游戏库和最近游玩记录中排除。同步完成后，远端已有的相关记录也会撤回。每次重新登录默认关闭作品分享。网络中断后，好友看到的在线状态会在超时后失效。</p>
        </CardContent></Card>
      </div>
      <Card><CardHeader><CardTitle>添加好友</CardTitle></CardHeader><CardContent className="space-y-3">
        <form className="flex max-w-lg flex-wrap gap-2" onSubmit={e=>{e.preventDefault();void searchUsers();}}>
          <Input aria-label="搜索用户名或好友码" placeholder="输入用户名或 16 位好友码" value={addQuery} maxLength={32} onChange={e=>setAddQuery(e.target.value)} disabled={busy||searching} className="min-w-0 flex-1"/>
          <Button type="submit" disabled={busy||searching||!addQuery.trim()} loading={searching}>{searching?'搜索中…':'搜索'}</Button>
        </form>
        <p className="text-xs leading-relaxed text-muted-foreground">支持用户名前缀搜索，也可以输入对方的 16 位好友码精确定位。搜索结果需要确认后才会发送好友申请。</p>
        {searchResults!==null?<div className="space-y-2">{searchResults.length?searchResults.map(user=><div key={user.id} className="flex flex-wrap items-center gap-3 rounded-md border border-border p-3">
          <Avatar user={user}/>
          <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{user.nickname}</p><p className="truncate text-xs text-muted-foreground">@{user.username}{user.friendCode?<> · <code className="select-all">{user.friendCode}</code></>:null}</p></div>
          <Badge variant="secondary">{relationLabel(user.relation)}</Badge>
          {user.relation==='none'?<Button size="sm" disabled={busy} onClick={()=>setAddTarget(user)}>添加</Button>:null}
          {user.relation==='incoming'?<a href={`#friend-request-${user.id}`} className="text-xs text-primary hover:underline">处理申请</a>:null}
        </div>):<p role="status" className="text-xs text-muted-foreground">没有找到匹配的用户，请检查用户名或好友码。</p>}</div>:null}
      </CardContent></Card>
      {(view?.incoming.length||view?.outgoing.length)?<Card><CardHeader><CardTitle><span id="friend-requests">好友申请</span></CardTitle></CardHeader><CardContent className="space-y-3">
        {view.incoming.map(request=><div key={request.id} id={`friend-request-${request.user.id}`} className="flex flex-wrap items-center gap-3"><Avatar user={request.user}/><span className="min-w-0 flex-1 truncate text-sm">{request.user.nickname} <span className="text-muted-foreground">@{request.user.username}</span> 想添加你为好友</span><Button size="sm" disabled={busy} onClick={()=>action('accept',request.id)}>同意</Button><Button size="sm" variant="ghost" disabled={busy} onClick={()=>action('reject',request.id)}>拒绝</Button></div>)}
        {view.outgoing.map(request=><div key={request.id} className="flex items-center gap-3 text-sm"><span className="min-w-0 flex-1 truncate">已向 {request.user.nickname} <span className="text-muted-foreground">@{request.user.username}</span> 发送申请</span><Button size="sm" variant="ghost" disabled={busy} onClick={()=>action('cancel',request.id)}>取消申请</Button></div>)}
      </CardContent></Card>:null}
      <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">好友列表 <span className="text-sm font-normal text-muted-foreground">{friends.length} 人</span></h2><Button size="sm" variant="outline" disabled={busy} onClick={()=>void controller.current?.refresh()}>刷新</Button></div>
      {friends.length?<div className="flex flex-wrap items-center gap-3"><Input aria-label="搜索好友" placeholder="搜索昵称或用户名" value={friendQuery} onChange={e=>setFriendQuery(e.target.value)} className="max-w-sm"/><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={onlineOnly} onChange={e=>setOnlineOnly(e.target.checked)}/>仅看在线</label></div>:null}
      {view?.stale?<p role="status" className="text-sm text-muted-foreground">连接中断，好友状态待更新。</p>:null}
      {!view?<p role="status" className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{error?'暂时无法获取好友列表，请检查连接后刷新。':'正在获取好友列表…'}</p>:!friends.length?<p className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">还没有好友，把你的好友码发给一起推 Galgame 的朋友吧。</p>:!filteredFriends.length?<p role="status" className="text-sm text-muted-foreground">没有符合条件的好友。</p>:<div className="grid gap-3 md:grid-cols-2">{filteredFriends.map(friend=><div key={friend.id} className="flex min-w-0 items-start gap-3 rounded-lg border border-border bg-card p-4">
        <Link to={`/friends/${encodeURIComponent(friend.id)}`} aria-label={`查看 ${friend.nickname} 的主页`} className="shrink-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><Avatar user={friend}/></Link>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-1"><Link to={`/friends/${encodeURIComponent(friend.id)}`} className="truncate rounded font-medium hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">{friend.nickname}</Link><span className="truncate text-xs text-muted-foreground">@{friend.username}</span></div>
          <p className="mt-1 text-xs text-muted-foreground">{view.stale?'状态待更新':friend.online?friend.game?'正在游玩':'在线':'离线'}</p>
          {!view.stale&&friend.online&&friend.game?<><p className="mt-2 break-words text-sm font-medium text-primary">{friend.game.title}</p><p className="mt-1 text-xs text-muted-foreground">本次已玩 {formatPlayTime(elapsedSeconds(friend.game,view,clock))}</p></>:null}
          <div className="mt-3 flex flex-wrap gap-3">
            <Link to={`/friends/${encodeURIComponent(friend.id)}`} className="rounded text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">查看主页</Link>
            <button type="button" className="text-xs text-muted-foreground hover:text-destructive" disabled={busy} onClick={()=>setReportTarget({id:friend.id,username:friend.username,nickname:friend.nickname,gameKey:null,defaultReason:'cover'})}>举报</button>
            <button disabled={busy} className="text-xs text-muted-foreground hover:text-destructive" onClick={()=>setConfirm({action:'remove',user:friend})}>删除好友</button>
            <button disabled={busy} className="text-xs text-muted-foreground hover:text-destructive" onClick={()=>setConfirm({action:'block',user:friend})}>屏蔽</button>
          </div>
        </div>
      </div>)}</div>}
      {view?.blocked.length?<details className="rounded-lg border border-border bg-card p-4"><summary className="cursor-pointer text-sm">已屏蔽 · {view.blocked.length} 人</summary><div className="mt-3 space-y-2">{view.blocked.map(user=><div key={user.id} className="flex items-center justify-between gap-3 text-sm"><span>{user.nickname}</span><Button size="sm" variant="ghost" disabled={busy} onClick={()=>action('unblock',user.id)}>解除屏蔽</Button></div>)}</div></details>:null}
    </>}
    <ConfirmDialog open={Boolean(confirm)} title={confirm?.action==='block'?'屏蔽此用户？':'删除好友？'} description={confirm?`${confirm.user.nickname} 将无法继续查看你的在线状态、游玩状态和公开游戏库。`:''} confirmText={confirm?.action==='block'?'屏蔽':'删除好友'} destructive onCancel={()=>setConfirm(null)} onConfirm={()=>{if(confirm){action(confirm.action,confirm.user.id);setConfirm(null);}}}/>
    <ConfirmDialog open={Boolean(addTarget)} title="发送好友申请？" description={addTarget?`确认向 @${addTarget.username}（${addTarget.nickname}）发送好友申请？`:''} confirmText="发送申请" busy={busy} onCancel={()=>setAddTarget(null)} onConfirm={()=>{if(addTarget)requestUser(addTarget);}}/>
    <AvatarPickerDialog open={avatarOpen} current={avatar} saving={busy} onClose={()=>setAvatarOpen(false)} onConfirm={saveAvatar}/>
    <ReportDialog open={Boolean(reportTarget)} busy={busy} defaultReason={reportTarget?.defaultReason??'cover'} target={reportTarget?{username:reportTarget.username,nickname:reportTarget.nickname}:null} onClose={()=>setReportTarget(null)} onSubmit={submitReport}/>
  </div>;
}
