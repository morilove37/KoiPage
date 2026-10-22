import { useState } from 'react';
import type { ReactNode } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { CoverImage } from '@/components/ui/cover-image';
import { backgroundAssetGrant, gameCoverImport } from '@/lib/db';
import { loadCoverPreferences, updateCoverPreferences, useGameCover } from './store';

/** Library control: custom image selection lives exclusively on the detail page. */
export function CoverCensorButton({ gameId, title, className = '' }: { gameId: number; title: string; className?: string }) {
  const { preferences, loaded, saving } = useGameCover(gameId);
  const [error, setError] = useState<string | null>(null);
  return <div className={className}>
    <button type="button" disabled={!loaded || saving} aria-pressed={preferences.censored}
      aria-label={`${preferences.censored ? '取消' : '开启'}「${title}」封面打码`}
      title={preferences.censored ? '取消封面打码' : '封面打码'}
      onClick={event => {
        event.preventDefault(); event.stopPropagation(); setError(null);
        void updateCoverPreferences(gameId, { censored: !preferences.censored }).catch(cause => setError(String(cause)));
      }}
      className="rounded border border-white/20 bg-black/75 px-2 py-1 text-[11px] text-white shadow hover:bg-black/90 disabled:opacity-50">
      {saving ? '保存中…' : preferences.censored ? '取消打码' : '打码'}
    </button>
    {error ? <p role="alert" className="max-w-48 rounded bg-card p-1 text-xs text-destructive">{error}</p> : null}
  </div>;
}

export function CoverControls({ gameId, sourcePath, title, cropControls }: { gameId: number; sourcePath: string | null; title: string; cropControls?: ReactNode }) {
  const { preferences, loaded, saving, error: loadError } = useGameCover(gameId);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function run(action: () => Promise<void>, message: string) {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); setNotice(message); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="mt-3 flex flex-col gap-2" data-cover-controls>
    {cropControls}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!loaded || busy || saving} onClick={() => void run(async () => {
        const path = await open({ title: '选择自定义封面', multiple: false,
          filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }] });
        if (typeof path === 'string') { await backgroundAssetGrant(path); setSelected(path); }
      }, '')}>自定义封面</Button>
      {preferences.customPath ? <Button size="sm" variant="outline" disabled={busy || saving} onClick={() => void run(
        () => updateCoverPreferences(gameId, { customPath: null }), '已恢复原封面。',
      )}>恢复原封面</Button> : null}
      <Button size="sm" variant="outline" disabled={!loaded || busy || saving} aria-pressed={preferences.censored}
        onClick={() => void run(() => updateCoverPreferences(gameId, { censored: !preferences.censored }),
          preferences.censored ? '已取消封面打码。' : '已开启封面打码。')}>{preferences.censored ? '取消打码' : '封面打码'}</Button>
    </div>
    <p className="text-[11px] text-muted-foreground">{preferences.customPath ? '使用自定义封面' : '使用原封面'}{preferences.censored ? ' · 已打码' : ''} · 设置即时保存</p>
    {error || loadError ? <p role="alert" className="text-xs text-destructive">{error ?? loadError}</p> : null}
    {!loaded && loadError ? <Button size="sm" variant="outline" onClick={() => void run(loadCoverPreferences, '已重新读取封面设置。')}>重试读取</Button> : null}
    {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
    <Dialog open={selected !== null} title="预览自定义封面" description="保存后用于此游戏的封面展示，原封面保留，可随时恢复。"
      onClose={() => { if (!busy) setSelected(null); }}
      footer={<><Button variant="outline" disabled={busy} onClick={() => setSelected(null)}>取消</Button>
        <Button disabled={busy} onClick={() => void run(async () => {
          if (!selected) return;
          const path = await gameCoverImport(gameId, selected);
          await updateCoverPreferences(gameId, { customPath: path }); setSelected(null);
        }, '自定义封面已保存。')}>{busy ? '保存中…' : '保存封面'}</Button></>}>
      <div className="mx-auto aspect-[3/4] max-h-80 overflow-hidden rounded bg-muted">
        <CoverImage path={selected} alt={`${title}的自定义封面预览`} censored={preferences.censored} loading="eager" className="h-full w-full object-contain" />
      </div>
      {sourcePath ? <p className="mt-3 text-xs text-muted-foreground">恢复原封面时会使用当前资料中的封面。</p> : null}
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
    </Dialog>
  </div>;
}
