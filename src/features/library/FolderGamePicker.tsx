import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import type { Game } from '@/types/game';
import type { LibraryFolder } from './folders';

export function FolderGamePicker({ folder, games, busy, onClose, onSave }: {
  folder: LibraryFolder; games: Game[]; busy: boolean; onClose: () => void; onSave: (ids: number[]) => Promise<boolean>;
}) {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(() => new Set(games.filter(game => folder.gameIds.includes(game.id)).map(game => game.id)));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const locked = busy || saving;
  const existing = useMemo(() => new Set(folder.gameIds), [folder.gameIds]);
  const matching = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return games.filter(game => [game.title, game.originalTitle, game.developer].some(value => value?.toLowerCase().includes(needle)))
      .sort((a,b) => a.title.localeCompare(b.title,'zh-Hans-CN',{numeric:true}));
  }, [games, search]);
  const selectedGames = games.filter(game => selected.has(game.id));
  const added = selectedGames.filter(game => !existing.has(game.id)).length;
  const removed = games.filter(game => existing.has(game.id) && !selected.has(game.id)).length;
  const save = async () => {
    if (locked) return;
    setError('');
    setSaving(true);
    try {
      if (await onSave(selectedGames.map(game => game.id))) onClose(); else setError('保存归类失败，请重试。');
    } catch {
      setError('保存归类失败，请重试。');
    } finally {
      setSaving(false);
    }
  };
  return <Dialog open title={`管理「${folder.name}」中的游戏`} description="勾选加入、取消勾选移出，保存后统一生效。移出仅取消此文件夹中的归类，不会删除游戏文件。" onClose={() => { if (!locked) onClose(); }} className="max-w-2xl"
    footer={<><span className="mr-auto text-xs text-muted-foreground" aria-live="polite">已选 {selectedGames.length} 部<br />新增 {added} 部 · 移出 {removed} 部</span><Button variant="outline" disabled={locked} onClick={onClose}>取消</Button><Button disabled={locked} onClick={() => void save()}>{saving ? '保存中…' : '保存归类'}</Button></>}>
    <div className="flex flex-col gap-3">
      <Input autoFocus aria-label="搜索要归类的游戏" placeholder="搜索标题 / 原名 / 开发商" value={search} onChange={event => setSearch(event.target.value)} disabled={locked} />
      <div className="flex items-center gap-2 text-xs">
        <span className="mr-auto text-muted-foreground">显示 {matching.length} 部 · 文件夹内已有 {games.filter(game => existing.has(game.id)).length} 部</span>
        <Button size="sm" variant="outline" disabled={locked || !matching.some(game => !selected.has(game.id))} onClick={() => setSelected(current => new Set([...current,...matching.map(game => game.id)]))}>全选搜索结果</Button>
        <Button size="sm" variant="ghost" disabled={locked || !matching.some(game => selected.has(game.id))} onClick={() => setSelected(current => {
          const next = new Set(current); matching.forEach(game => next.delete(game.id)); return next;
        })}>取消选择搜索结果</Button>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-border divide-y divide-border" aria-label="可归类游戏">
        {matching.map(game => <label key={game.id} className="flex cursor-pointer items-center gap-3 px-3 py-3 hover:bg-accent/50">
          <input type="checkbox" aria-label={`选择${game.title}`} checked={selected.has(game.id)} disabled={locked} onChange={() => setSelected(current => {
            const next = new Set(current); if (next.has(game.id)) next.delete(game.id); else next.add(game.id); return next;
          })} />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm" title={game.title}>{game.title}</span><span className="block truncate text-xs text-muted-foreground">{game.developer ?? '未知社团'}</span></span>
          {existing.has(game.id) ? <span className="shrink-0 text-xs text-muted-foreground">已在此文件夹</span> : null}
        </label>)}
        {!matching.length ? <p className="p-6 text-center text-sm text-muted-foreground">{games.length ? '没有匹配的游戏，请更换关键词。' : '游戏库暂无游戏，请先添加游戏。'}</p> : null}
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  </Dialog>;
}
