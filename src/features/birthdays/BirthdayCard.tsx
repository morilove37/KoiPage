import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { GeometryIcon } from '@/components/ui/geometry-icon';
import type { Game } from '@/types/game';
import { birthdayDate, buildBirthdayEntries } from './model';
import { BirthdayDetailDialog, BirthdayListDialog, BirthdayRow } from './BirthdayDialogs';
import { useBirthdays, useLocalBirthdayDay } from './useBirthdays';

export function BirthdayCard({ games }: { games: Game[] }) {
  const libraryKey = JSON.stringify(games.map(g => [g.id, g.vndbId, g.bangumiId]));
  const { snapshot, error, starting, refresh, sync, cancel } = useBirthdays(libraryKey);
  const now = useLocalBirthdayDay();
  const [listOpen, setListOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const entries = useMemo(() => buildBirthdayEntries(snapshot?.characters ?? [], now), [snapshot?.characters, now]);
  const today = entries.filter(e => e.days === 0);
  const upcoming = entries.filter(e => e.days > 0);
  const shown = (today.length ? today : upcoming).slice(0, 3);
  const character = snapshot?.characters.find(c => c.id === selected);
  const p = snapshot?.progress;
  const failures = snapshot?.sync.filter(s => s.status === 'error').length ?? 0;
  const unmatched = snapshot?.sync.filter(s => s.status === 'unmatched').length ?? 0;
  const matched = (snapshot?.sync.length ?? 0) - unmatched;
  const unknown = snapshot?.characters.filter(c => !c.hidden && (!c.birthdayMonth || !c.birthdayDay)).length ?? 0;
  const hasKnownBirthday = snapshot?.characters.some(c => !c.hidden && c.birthdayMonth && c.birthdayDay) ?? false;
  const updateTimes = snapshot?.sync.flatMap(s => s.syncedAt ? [s.syncedAt] : []).sort() ?? [];
  const syncedAt = updateTimes[updateTimes.length - 1];
  const emptyText = !snapshot ? '正在读取角色生日…' : p?.running ? '正在获取角色资料，已有资料会陆续显示。'
    : !snapshot.enabled && snapshot.characters.length === 0 ? '记住故事里的相遇，也记住她们的生日。'
    : matched === 0 ? '先为游戏匹配 VNDB 或 Bangumi 资料，就能找到关联角色。'
    : failures > 0 && snapshot.characters.length === 0 ? '暂时无法获取角色资料，请检查网络后重试。'
    : snapshot.characters.some(c => c.hidden) && snapshot.characters.every(c => c.hidden) ? '角色都已隐藏，可在全部角色中恢复。'
    : unknown > 0 && !hasKnownBirthday ? `${unknown} 位角色的生日尚未明确，可在全部角色中补充。`
    : '未来 30 天内暂无角色生日。';
  return <>
    <section data-birthday-card aria-labelledby="home-birthday-heading" className="min-w-0 overflow-hidden rounded-lg border border-border bg-card text-card-foreground">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id="home-birthday-heading" className="flex items-center gap-2 text-sm font-semibold"><GeometryIcon name="cake" className="text-primary" />角色生日</h2>
        <button type="button" className="rounded text-[11px] text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setListOpen(true)}>全部角色 ↗</button>
      </div>
      {shown.length > 0 ? <>
        <div className="flex items-center justify-between px-4 pt-3 text-[11px]"><span className={today.length ? 'font-medium text-primary' : 'text-muted-foreground'}>{today.length ? '今日寿星' : '即将生日'}</span><span className="text-muted-foreground">{today.length ? `${today.length} 位 · 生日快乐` : '未来 30 天'}</span></div>
        <div className="mt-2 divide-y divide-border">{shown.map(e => <BirthdayRow key={e.character.id} character={e.character} now={now} onClick={() => setSelected(e.character.id)} />)}</div>
        {today.length > 3 ? <button type="button" onClick={() => setListOpen(true)} className="w-full px-4 py-2 text-xs text-primary hover:bg-accent/50">查看今天全部 {today.length} 位寿星 →</button> : null}
        {today.length > 0 && upcoming[0] ? <button type="button" className="flex w-full items-center gap-2 border-t border-border px-4 py-3 text-left text-[11px] text-muted-foreground hover:bg-accent/50" onClick={() => setSelected(upcoming[0].character.id)}><span className="shrink-0">下一位</span><span className="min-w-0 flex-1 truncate">{upcoming[0].character.name}</span><span className="shrink-0">{birthdayDate(upcoming[0].character)}</span></button> : null}
      </> : <div className="space-y-3 px-4 py-5">
        <p className="text-xs leading-relaxed text-muted-foreground">{emptyText}</p>
        {snapshot && !snapshot.enabled && !p?.running && matched > 0 ? <Button size="sm" variant="outline" loading={starting} onClick={() => void sync(true)}>获取角色生日</Button> : null}
        {snapshot && unmatched > 0 && matched === 0 ? <Button size="sm" variant="outline" onClick={() => setListOpen(true)}>查看待匹配作品</Button> : null}
      </div>}
      <div className="space-y-2 border-t border-border px-4 py-2.5">
        {p?.running ? <div className="space-y-2">
          <div className="flex min-w-0 items-center gap-2"><p role="status" className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">{p.cancelling ? '正在取消…' : `同步 ${p.completed} / ${p.total}${p.current ? ` · ${p.current}` : ''}`}</p><button type="button" disabled={p.cancelling} onClick={() => void cancel()} className="shrink-0 rounded text-[11px] text-primary disabled:opacity-50">取消</button></div>
          <div role="progressbar" aria-label="角色生日同步进度" aria-valuenow={p.completed} aria-valuemin={0} aria-valuemax={p.total} className="h-1 overflow-hidden rounded-full bg-primary/10"><div className="h-full bg-primary transition-[width]" style={{ width: `${p.total ? p.completed / p.total * 100 : 0}%` }} /></div>
        </div> : <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span>{syncedAt ? `更新于 ${new Date(syncedAt).toLocaleDateString('zh-CN')} · 本地缓存` : '生日资料来自 VNDB / Bangumi'}</span>
          {snapshot?.enabled || snapshot?.characters.length ? <button type="button" disabled={starting || matched === 0} onClick={() => void sync(true)} className="shrink-0 rounded text-primary disabled:opacity-50">{starting ? '准备中…' : '更新资料'}</button> : null}
        </div>}
        {error || failures > 0 || p?.error ? <p role="status" className="text-[11px] leading-relaxed text-muted-foreground">{error ?? (failures ? `${failures} 部作品同步失败，已有资料仍可查看。` : p?.error)} <button type="button" className="text-primary hover:underline" onClick={() => { if (error) void refresh(); else setListOpen(true); }}>{error ? '重试' : '查看详情'}</button></p> : null}
      </div>
    </section>
    {character ? <BirthdayDetailDialog key={character.id} character={character} now={now} onChanged={refresh} onClose={() => setSelected(null)} onBack={listOpen ? () => setSelected(null) : undefined} />
      : listOpen && snapshot ? <BirthdayListDialog snapshot={snapshot} now={now} onChanged={refresh} onClose={() => setListOpen(false)} onSelect={setSelected} /> : null}
  </>;
}
