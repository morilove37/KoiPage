import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { open, save } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Button } from '@/components/ui/button';
import { CoverImage } from '@/components/ui/cover-image';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/input';
import { errorMessage } from '@/features/io/io';
import { birthdayDate, birthdayLabel, birthdayOccurrence, buildBirthdayEntries } from './model';
import { birthdaysExport, birthdaysImport, birthdaysUpdate } from './io';
import type { BirthdayCharacter, BirthdaySnapshot } from './types';

function useBirthdayDialogFocus() {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = document.querySelector<HTMLElement>('.birthday-dialog');
    if (!dialog) return;
    const controls = () => [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')].filter(e => e.getClientRects().length > 0);
    controls()[0]?.focus({ preventScroll: true });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const all = controls(); const first = all[0]; const last = all[all.length - 1];
      if (!first) return;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    dialog.addEventListener('keydown', trap);
    return () => { dialog.removeEventListener('keydown', trap); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
}

export function BirthdayRow({ character, now, onClick }: { character: BirthdayCharacter; now: Date; onClick: () => void }) {
  const next = birthdayOccurrence(character.birthdayMonth, character.birthdayDay, now);
  return <button type="button" onClick={onClick} className={`flex w-full min-w-0 items-center gap-2.5 px-4 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${next?.days === 0 ? 'bg-primary/5' : ''}`}>
    <span className="size-9 shrink-0 overflow-hidden rounded-lg bg-primary/10"><CoverImage path={character.avatarPath} alt="" className="h-full w-full object-cover object-top" fallbackText={character.name.slice(0, 1)} /></span>
    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{character.name}</span><span className="mt-1 block truncate text-[11px] text-muted-foreground">{character.games.map(g => g.title).join(' / ')}</span>{next?.observed ? <span className="mt-1 block text-[10px] text-muted-foreground">平年于 3 月 1 日庆祝</span> : null}</span>
    <span className="shrink-0 text-right"><span className={`block text-[11px] ${next?.days === 0 ? 'font-medium text-primary' : 'text-muted-foreground'}`}>{character.hidden ? '已隐藏' : next ? birthdayLabel(next) : '待补充'}</span><span className="mt-1 block text-[10px] text-muted-foreground">{birthdayDate(character)}</span></span>
  </button>;
}

export function BirthdayDetailDialog({ character, now, onClose, onChanged, onBack }: {
  character: BirthdayCharacter; now: Date; onClose: () => void; onChanged: () => Promise<unknown>; onBack?: () => void;
}) {
  useBirthdayDialogFocus();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(character.name);
  const [month, setMonth] = useState(String(character.birthdayMonth ?? ''));
  const [day, setDay] = useState(String(character.birthdayDay ?? ''));
  const [hidden, setHidden] = useState(character.hidden);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const next = birthdayOccurrence(character.birthdayMonth, character.birthdayDay, now);
  const sourceName = character.source === 'vndb' ? 'VNDB' : 'Bangumi';
  const sourceUrl = character.source === 'vndb' ? `https://vndb.org/${character.externalId}` : `https://bgm.tv/character/${character.externalId}`;
  async function update(reset = false) {
    if (busy) return;
    const m = month.trim() === '' ? null : Number(month);
    const d = day.trim() === '' ? null : Number(day);
    if (!reset && ((m === null) !== (d === null) || (m !== null && !birthdayOccurrence(m, d, now)))) { setError('请输入有效的生日月日，或同时留空。'); return; }
    setBusy(true); setError(null);
    try { await birthdaysUpdate(character.id, { name, month: m, day: d, avatarFile: avatar, hidden, reset }); await onChanged(); onClose(); }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function pickAvatar() {
    try {
      const file = await open({ title: '选择角色头像', multiple: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
      if (typeof file === 'string') setAvatar(file);
    } catch (e) { setError(errorMessage(e)); }
  }
  return <Dialog open onClose={() => { if (!busy) onClose(); }} title={editing ? '修正角色资料' : character.name} className="birthday-dialog max-w-md"
    footer={<div className="flex w-full flex-wrap justify-end gap-2">{onBack && !editing ? <Button size="sm" variant="ghost" onClick={onBack}>返回列表</Button> : null}<Button size="sm" variant="outline" disabled={busy} onClick={onClose}>关闭</Button>{editing ? <Button size="sm" loading={busy} onClick={() => void update()}>保存资料</Button> : <Button size="sm" onClick={() => setEditing(true)}>修正资料</Button>}</div>}>
    <div className="flex items-center gap-4">
      <div className="h-20 w-16 shrink-0 overflow-hidden rounded-lg bg-primary/10"><CoverImage path={character.avatarPath} alt={character.name} className="h-full w-full object-cover object-top" fallbackText={character.name.slice(0, 1)} /></div>
      <div className="min-w-0 space-y-2"><p className="break-words text-base font-semibold">{character.name}</p>{character.originalName && character.originalName !== character.name ? <p className="break-words text-xs text-muted-foreground">{character.originalName}</p> : null}<p className="text-sm text-primary">{birthdayDate(character)}{next ? ` · ${birthdayLabel(next)}` : ''}</p>{next?.observed ? <p className="text-xs text-muted-foreground">原生日 2 月 29 日，平年于 3 月 1 日庆祝。</p> : null}<p className="text-[11px] text-muted-foreground">资料来自 {sourceName}{character.customized ? ' · 已手动修正' : ''}{character.hidden ? ' · 已隐藏' : ''}</p></div>
    </div>
    {editing ? <form className="mt-5 space-y-4" onSubmit={e => { e.preventDefault(); void update(); }}>
      <Field label="显示名称"><Input value={name} maxLength={100} disabled={busy} onChange={e => setName(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3"><Field label="生日月份"><Input type="number" inputMode="numeric" min={1} max={12} placeholder="未知可留空" value={month} disabled={busy} onChange={e => setMonth(e.target.value)} /></Field><Field label="生日日期"><Input type="number" inputMode="numeric" min={1} max={31} placeholder="未知可留空" value={day} disabled={busy} onChange={e => setDay(e.target.value)} /></Field></div>
      <div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void pickAvatar()}>选择头像</Button><span className="min-w-0 text-xs text-muted-foreground">{avatar ? '已选择新头像，保存后生效' : 'PNG / JPEG / WebP / GIF，最多 4 MB'}</span></div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={hidden} disabled={busy} onChange={e => setHidden(e.target.checked)} className="accent-primary" />在首页隐藏此角色</label>
      <p className="text-xs text-muted-foreground">修正内容会保留，不会被自动同步覆盖。隐藏后可在「全部角色 → 已隐藏」中恢复。</p>
      {character.customized ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void update(true)}>恢复来源资料</Button> : null}
      <button type="submit" className="sr-only" tabIndex={-1}>保存资料</button>
    </form> : <div className="mt-5 space-y-3"><p className="text-xs text-muted-foreground">关联作品</p>{character.games.map(g => <Link key={g.id} to={`/library/${g.id}`} onClick={onClose} className="block rounded-md border border-border px-3 py-2 text-sm hover:bg-accent">{g.title} <span aria-hidden="true">↗</span></Link>)}<Button size="sm" variant="ghost" onClick={() => { void openUrl(sourceUrl).catch(e => setError(errorMessage(e))); }}>打开 {sourceName} 资料 ↗</Button></div>}
    {error ? <p role="alert" className="mt-3 text-xs text-destructive">{error}</p> : null}
  </Dialog>;
}

export function BirthdayListDialog({ snapshot, now, onClose, onSelect, onChanged }: {
  snapshot: BirthdaySnapshot; now: Date; onClose: () => void; onSelect: (id: string) => void; onChanged: () => Promise<unknown>;
}) {
  useBirthdayDialogFocus();
  const [search, setSearch] = useState(''); const [hidden, setHidden] = useState(false); const [limit, setLimit] = useState(40);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState<string | null>(null); const [error, setError] = useState<string | null>(null);
  const ordered = useMemo(() => {
    const entries = buildBirthdayEntries(snapshot.characters, now, Infinity).map(e => e.character);
    const unknown = snapshot.characters.filter(c => !c.hidden && !birthdayOccurrence(c.birthdayMonth, c.birthdayDay, now));
    const candidates = hidden ? snapshot.characters.filter(c => c.hidden) : [...entries, ...unknown];
    const needle = search.trim().toLocaleLowerCase();
    return candidates.filter(c => [c.name, c.originalName, ...c.games.map(g => g.title)].some(v => v?.toLocaleLowerCase().includes(needle)));
  }, [snapshot.characters, now, hidden, search]);
  async function transfer(importing: boolean) {
    if (busy) return; setBusy(true); setError(null); setMessage(null);
    try {
      const filters = [{ name: '角色生日资料', extensions: ['json'] }];
      const path = importing ? await open({ title: '导入生日资料（将覆盖文件中角色的个人修正）', multiple: false, filters }) : await save({ title: '导出生日资料', defaultPath: 'KoiPage-角色生日.json', filters });
      if (typeof path !== 'string') return;
      const count = importing ? await birthdaysImport(path) : await birthdaysExport(path);
      await onChanged(); setMessage(`已${importing ? '导入' : '导出'} ${count} 位角色的资料、修正和头像。`);
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  const failures = snapshot.sync.filter(s => s.status === 'error'); const unmatched = snapshot.sync.filter(s => s.status === 'unmatched');
  return <Dialog open onClose={() => { if (!busy) onClose(); }} title="游戏库角色生日" description="按下一次生日排序，包含生日待补充的角色。" className="birthday-dialog max-w-xl"
    footer={<div className="flex w-full flex-wrap items-center gap-2"><Button size="sm" variant="outline" disabled={busy || snapshot.progress.running} onClick={() => void transfer(true)}>导入资料</Button><Button size="sm" variant="outline" disabled={busy || snapshot.characters.length === 0} onClick={() => void transfer(false)}>导出资料</Button><Button size="sm" className="ml-auto" disabled={busy} onClick={onClose}>关闭</Button></div>}>
    <div className="space-y-3">
      <Input aria-label="搜索角色或作品" placeholder="搜索角色或作品…" value={search} onChange={e => { setSearch(e.target.value); setLimit(40); }} />
      <div className="flex flex-wrap gap-2" role="group" aria-label="角色范围"><Button size="sm" variant={!hidden ? 'secondary' : 'ghost'} aria-pressed={!hidden} onClick={() => { setHidden(false); setLimit(40); }}>全部角色</Button><Button size="sm" variant={hidden ? 'secondary' : 'ghost'} aria-pressed={hidden} onClick={() => { setHidden(true); setLimit(40); }}>已隐藏（{snapshot.characters.filter(c => c.hidden).length}）</Button><span className="ml-auto self-center text-xs text-muted-foreground">{ordered.length} 位</span></div>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">{ordered.slice(0, limit).map(c => <BirthdayRow key={c.id} character={c} now={now} onClick={() => onSelect(c.id)} />)}{ordered.length === 0 ? <p className="p-6 text-center text-xs text-muted-foreground">{hidden ? '没有符合条件的隐藏角色。' : '暂无符合条件的角色资料。'}</p> : null}</div>
      {ordered.length > limit ? <Button size="sm" variant="ghost" onClick={() => setLimit(n => n + 40)}>再显示 40 位</Button> : null}
      {failures.length > 0 ? <details className="rounded-md border border-border p-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{failures.length} 部作品同步失败</summary><div className="mt-2 space-y-2">{failures.map(s => <p key={s.gameId} className="break-words">{s.title}：{s.error}</p>)}</div></details> : null}
      {unmatched.length > 0 ? <details className="rounded-md border border-border p-3 text-xs"><summary className="cursor-pointer text-muted-foreground">{unmatched.length} 部作品需要先匹配游戏资料</summary><div className="mt-2 flex flex-col gap-2">{unmatched.map(s => <Link key={s.gameId} to={`/library/${s.gameId}`} onClick={onClose} className="text-primary hover:underline">{s.title} ↗</Link>)}</div></details> : null}
      <p className="text-[11px] text-muted-foreground">导出包含头像、生日修正与隐藏设置，导入后按作品来源关联到当前游戏库。数据库备份也会保留生日资料及修正。</p>
      {busy ? <p role="status" className="text-xs text-muted-foreground">正在处理生日资料…</p> : null}{message ? <p role="status" className="text-xs text-primary">{message}</p> : null}{error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  </Dialog>;
}
