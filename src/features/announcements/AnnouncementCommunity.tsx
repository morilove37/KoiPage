import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button, buttonClassName } from '@/components/ui/button';
import { BRAND } from '@/lib/brand';

const communityCard = 'flex min-w-0 flex-col gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3';
const communityAction = 'mt-auto w-full';

/** The same invitation and joining instructions appear in both announcements. */
export function AnnouncementCommunity() {
  const [copied,setCopied]=useState(false);
  const [error,setError]=useState('');
  const [supportError,setSupportError]=useState('');
  useEffect(()=>{if(!copied)return;const timer=window.setTimeout(()=>setCopied(false),2000);return()=>window.clearTimeout(timer);},[copied]);
  const copy=async()=>{
    setError('');
    try {
      if(isTauri())await writeText(BRAND.communityGroup);else await navigator.clipboard.writeText(BRAND.communityGroup);
      setCopied(true);
    } catch {setError('复制失败，请选择群号手动复制。');}
  };
  return <div className="grid auto-rows-fr gap-3 sm:grid-cols-2">
    <section aria-label="爱发电支持" className={communityCard}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">爱发电支持</h3>
        <p className="text-xs leading-relaxed text-muted-foreground">如果恋页帮你整理了游戏库，欢迎支持后续开发。</p>
      </div>
      <a href={BRAND.supportUrl} target="_blank" rel="noopener noreferrer"
        className={buttonClassName({ className: communityAction })}
        onClick={event=>{
          if(!isTauri())return;
          event.preventDefault();setSupportError('');
          void openUrl(BRAND.supportUrl).catch(()=>setSupportError(`无法打开浏览器，请访问 ${BRAND.supportUrl}`));
        }}>在爱发电支持 <span aria-hidden="true">↗</span></a>
      {supportError?<p role="alert" className="select-all break-all text-xs text-destructive">{supportError}</p>:null}
    </section>
    <section aria-label="加入 QQ 群" className={communityCard}>
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">加入 QQ 群 <span className="select-all tabular-nums">{BRAND.communityGroup}</span></h3>
        <p className="text-xs leading-relaxed text-muted-foreground">推荐用手机 QQ 加群。入群前请阅读群介绍并回答问题。</p>
      </div>
      <Button className={communityAction} onClick={()=>void copy()}>{copied?'已复制':'复制群号'}</Button>
      <span role="status" className="sr-only">{copied?'群号已复制':null}</span>
      {error?<p role="alert" className="text-xs text-destructive">{error}</p>:null}
    </section>
  </div>;
}
