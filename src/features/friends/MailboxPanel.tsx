import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {GeometryIcon} from '@/components/ui/geometry-icon';
import type {GeometryIconName} from '@/components/ui/geometry-icon';
import {cn} from '@/lib/utils';
import {MAIL_PAGE_SIZE} from './mailbox-model';
import type {useMailbox} from './useMailbox';
import type {MailFilter,MailKind,MailMessage} from './types';

const labels:Record<MailKind,string>={announcement:'官方通知',library:'游戏库反馈',report:'举报反馈'};
const filters:{id:MailFilter;label:string;icon:GeometryIconName}[]=[
  {id:'all',label:'全部邮件',icon:'mail'},
  {id:'unread',label:'未读邮件',icon:'bookmark'},
  {id:'announcement',label:'官方通知',icon:'home'},
  {id:'library',label:'游戏库反馈',icon:'library'},
  {id:'report',label:'举报反馈',icon:'check'},
];
const shortDate=(value:string)=>new Date(value).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}).replace('/','.');
const fullDate=(value:string)=>new Date(value).toLocaleDateString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit'}).replace(/\//g,'.');

export function MailboxPanel({mail}:{mail:ReturnType<typeof useMailbox>}){
  const [selected,setSelected]=useState<MailMessage|null>(null);
  const {mailbox,loading,error,offset,filter}=mail;
  const page=Math.floor(offset/MAIL_PAGE_SIZE)+1;
  const pages=Math.max(1,Math.ceil((mailbox?.total??0)/MAIL_PAGE_SIZE));
  async function open(item:MailMessage){
    setSelected(item);
    if(!item.readAt&&await mail.read(item.id))setSelected(current=>current?.id===item.id?{...current,readAt:new Date().toISOString()}:current);
  }
  async function readAll(){
    if(await mail.readAll())setSelected(current=>current?{...current,readAt:current.readAt??new Date().toISOString()}:null);
  }
  function navigate(nextOffset:number,nextFilter=filter){
    setSelected(null);
    void mail.navigate(nextOffset,nextFilter);
  }
  return <section aria-label="站内邮件" className={cn('mailroom',selected&&'mailroom-has-selection')}>
    <div className="mailroom-topbar"><div><h2>邮件</h2><p>来自恋页的通知，以及你关心的处理结果。</p></div><span>{mailbox?`${mailbox.unread} 封未读`:'正在连接…'}</span></div>
    {error?<div role="alert" className="mailroom-error">邮件暂未更新：{error}<span>请稍后刷新重试，已显示的邮件为上次读取的内容。</span></div>:null}
    <div className="mailroom-workspace">
      <nav className="mailroom-categories" aria-label="邮件分类">
        {filters.map(item=><button key={item.id} type="button" className="mailroom-category" aria-pressed={filter===item.id}
          disabled={loading} onClick={()=>navigate(0,item.id)}>
          <GeometryIcon name={item.icon} className="size-6"/>
          <span>{item.label}</span>
          {item.id==='unread'&&Boolean(mailbox?.unread)?<span className="mailroom-category-count" aria-label={`${mailbox!.unread} 封未读邮件`}>{mailbox!.unread>99?'99+':mailbox!.unread}</span>:null}
        </button>)}
      </nav>
      <div className="mailroom-list-pane">
        <div className="mailroom-list-heading"><h2>{filters.find(item=>item.id===filter)?.label}</h2><span>{mailbox?`${mailbox.total} 封`:'连接中…'}</span></div>
        <div className="mailroom-list" aria-label="邮件列表" aria-busy={loading}>
          {!mailbox?<div role="status" className="mailroom-list-empty">{error?'暂时无法读取邮件':'正在收取邮件…'}</div>
            :!mailbox.items.length?<div className="mailroom-list-empty"><GeometryIcon name="mail" className="size-8"/>
              <p>{filter==='unread'?'未读邮件已清空':'这里还没有邮件'}</p><span>通知与处理结果会送达这里。</span></div>
            :mailbox.items.map(item=><button key={item.id} type="button" className="mailroom-list-item" disabled={loading}
              aria-current={selected?.id===item.id?'true':undefined} onClick={()=>void open(item)}>
              <div className="mailroom-item-title"><span className={!item.readAt?'font-semibold':''} title={item.title}>{item.title}</span>
                {!item.readAt?<span className="mailroom-unread" aria-label="未读"/>:<GeometryIcon name="mail" className="size-4 text-muted-foreground"/>}</div>
              <div className="mailroom-item-sender"><span title={`恋页 KoiPage · ${labels[item.kind]}`}><GeometryIcon name="friends" className="size-3.5"/><span>恋页 KoiPage · {labels[item.kind]}</span></span><time dateTime={item.createdAt}>{shortDate(item.createdAt)}</time></div>
            </button>)}
        </div>
        <div className="mailroom-list-footer">
          <div className="mailroom-pagination" aria-label="邮件分页"><span>{mailbox?`共 ${mailbox.total} 封`:'读取中…'}</span>
            <div><button type="button" aria-label="上一页" disabled={loading||offset===0} onClick={()=>navigate(Math.max(0,offset-MAIL_PAGE_SIZE))}><GeometryIcon name="arrow-left" className="size-3.5"/></button>
              <span>{page} / {pages}</span><button type="button" aria-label="下一页" disabled={loading||!mailbox?.hasMore} onClick={()=>navigate(offset+MAIL_PAGE_SIZE)}><GeometryIcon name="arrow-left" className="size-3.5 rotate-180"/></button></div>
          </div>
          <div className="mailroom-bulk-actions"><Button variant="outline" size="sm" disabled={loading||!mailbox?.unread} onClick={()=>void readAll()}><GeometryIcon name="check" className="size-3.5"/>全部已读</Button>
            <Button variant="outline" size="sm" disabled={loading} onClick={()=>void mail.refresh()}>{loading?'读取中…':'刷新邮件'}</Button></div>
        </div>
      </div>
      <article className="mailroom-reader" aria-label="邮件正文">
        {selected?<>
          <div className="mailroom-reader-back"><Button variant="ghost" size="sm" onClick={()=>setSelected(null)}><GeometryIcon name="arrow-left"/>返回邮件列表</Button></div>
          <header className="mailroom-reader-heading">
            <span className="mailroom-sender-mark"><GeometryIcon name="mail" className="size-7"/></span>
            <div className="mailroom-reader-title"><h2>{selected.title}</h2><p><GeometryIcon name="friends" className="size-3.5"/>恋页 KoiPage<span>·</span>{labels[selected.kind]}</p></div>
            <time className="mailroom-reader-date" dateTime={selected.createdAt}>{fullDate(selected.createdAt)}<span>{new Date(selected.createdAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</span></time>
          </header>
          <div className="mailroom-reader-body">{selected.body}</div>
          <footer className="mailroom-reader-footer"><span>官方站内邮件 · 无需回复</span><span className="mailroom-read-status"><GeometryIcon name={selected.readAt?'check':'mail'} className="size-3.5"/>{selected.readAt?'已读':'未读'}</span></footer>
        </>:<div className="mailroom-reader-empty"><GeometryIcon name="mail" className="size-12"/><h2>选择一封邮件</h2><p>在左侧查看通知和处理结果。</p></div>}
      </article>
    </div>
  </section>;
}
