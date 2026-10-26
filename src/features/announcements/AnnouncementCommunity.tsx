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
  return <section aria-label="交流群" className="rounded-lg border border-primary/25 bg-primary/5 p-4 text-sm">
    <h3 className="text-base font-semibold leading-relaxed">真的不进群玩玩吗？(｡･ω･｡)ﾉ♡</h3>
    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">交流游玩心得、提建议、反馈问题，都欢迎来坐坐～</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <p>QQ 群号：<span className="select-all text-base font-semibold tabular-nums tracking-wide text-primary">{BRAND.communityGroup}</span></p>
      <Button size="sm" variant="outline" onClick={()=>void copy()}>{copied?'已复制':'复制群号'}</Button>
    </div>
    <p className="mt-3 border-t border-primary/15 pt-3 text-xs leading-relaxed"><strong className="font-semibold">入群前请先阅读群介绍，并正确回答群介绍里的问题。</strong></p>
    <span role="status" className="sr-only">{copied?'群号已复制':null}</span>
    {error?<p role="alert" className="mt-2 text-xs text-destructive">{error}</p>:null}
  </section>;
}
