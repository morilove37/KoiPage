import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/lib/brand';

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
  return <section aria-label="交流群" className="border-b border-border pb-3 text-xs text-muted-foreground">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <p>QQ 群：<span className="select-all tabular-nums text-foreground">{BRAND.communityGroup}</span></p>
      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={()=>void copy()}>{copied?'已复制':'复制群号'}</Button>
    </div>
    <div className="mt-1 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
      <p className="leading-relaxed">加群前请阅读群介绍并回答入群问题，推荐使用手机 QQ。</p>
      <a href={BRAND.supportUrl} target="_blank" rel="noopener noreferrer"
        className="shrink-0 text-muted-foreground/70 underline-offset-4 hover:text-foreground hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={event=>{
          if(!isTauri())return;
          event.preventDefault();setSupportError('');
          void openUrl(BRAND.supportUrl).catch(()=>setSupportError(`无法打开浏览器，请访问 ${BRAND.supportUrl}`));
        }}>爱发电支持 <span aria-hidden="true">↗</span></a>
    </div>
    {supportError?<p role="alert" className="mt-1 text-xs text-destructive">{supportError}</p>:null}
    <span role="status" className="sr-only">{copied?'群号已复制':null}</span>
    {error?<p role="alert" className="mt-2 text-xs text-destructive">{error}</p>:null}
  </section>;
}
