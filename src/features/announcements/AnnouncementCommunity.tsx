import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { writeText } from '@tauri-apps/plugin-clipboard-manager';
import { Button } from '@/components/ui/button';
import { BRAND } from '@/lib/brand';

/** The same invitation and joining instructions appear in both announcements. */
export function AnnouncementCommunity() {
  const [copied,setCopied]=useState(false);
  const [error,setError]=useState('');
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
    <p className="mt-1 leading-relaxed">加群前请阅读群介绍并回答入群问题，推荐使用手机 QQ。</p>
    <span role="status" className="sr-only">{copied?'群号已复制':null}</span>
    {error?<p role="alert" className="mt-2 text-xs text-destructive">{error}</p>:null}
  </section>;
}
