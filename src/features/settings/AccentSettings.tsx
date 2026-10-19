import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { loadAccent, setAccent } from '@/lib/accent';
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  normalizeAccentHex,
  type AccentSettings as AccentChoice,
} from '@/lib/accent-model';

/** Settings → 外观. The surrounding ThemeSection owns the section/card. */
export function AccentSettings() {
  const [choice, setChoice] = useState<AccentChoice>({ ...DEFAULT_ACCENT });
  const [hexDraft, setHexDraft] = useState(DEFAULT_ACCENT.customHex);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const request = useRef(0);
  const choiceRef = useRef(choice);

  useEffect(() => {
    let alive = true;
    void loadAccent().then(stored => {
      if (!alive) return;
      choiceRef.current = stored;
      setChoice(stored);
      setHexDraft(stored.customHex);
      setLoaded(true);
    });
    return () => { alive = false; request.current++; };
  }, []);

  async function commit(next: AccentChoice) {
    const version = ++request.current;
    choiceRef.current = next;
    setChoice(next);
    setHexDraft(next.customHex);
    setError(null);
    setStatus(null);
    try {
      await setAccent(next);
      if (version === request.current) setStatus('主题色已保存');
    } catch (cause) {
      if (version === request.current) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(`主题色已应用，但保存失败：${message}。请重新选择以重试。`);
      }
    }
  }

  function applyHex() {
    const hex = normalizeAccentHex(hexDraft);
    if (!hex) {
      setError('请输入有效的十六进制颜色，例如 #7C3AED 或 #ABC。');
      return;
    }
    void commit({ preset: 'custom', customHex: hex });
  }

  return (
    <div className="mt-5 space-y-3 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-medium" id="accent-settings-label">主题色</h3>
          <p className="mt-1 text-xs text-muted-foreground">用于导航选中态、标签滑块、按钮与进度条；切换外观时保留。</p>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={!loaded} onClick={() => void commit({ ...DEFAULT_ACCENT })}>
          恢复默认
        </Button>
      </div>

      <div role="group" aria-labelledby="accent-settings-label" className="flex flex-wrap gap-2">
        {ACCENT_PRESETS.map(preset => (
          <button
            key={preset.id}
            type="button"
            aria-pressed={choice.preset === preset.id}
            disabled={!loaded}
            onClick={() => void commit({ ...choiceRef.current, preset: preset.id })}
            className={cn(
              'tap inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              choice.preset === preset.id ? 'border-ring bg-primary/10 text-foreground' : 'border-border bg-background hover:bg-accent',
            )}
          >
            <span aria-hidden="true" className="size-4 rounded-full border border-black/10" style={{ backgroundColor: preset.hex }} />
            {preset.label}
            {choice.preset === preset.id ? <span aria-hidden="true" className="text-primary">✓</span> : null}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={choice.preset === 'custom'}
          disabled={!loaded}
          onClick={() => void commit({ ...choiceRef.current, preset: 'custom' })}
          className={cn(
            'tap inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
            choice.preset === 'custom' ? 'border-ring bg-primary/10 text-foreground' : 'border-border bg-background hover:bg-accent',
          )}
        >
          <span aria-hidden="true" className="size-4 rounded-full border border-border" style={{ backgroundColor: choice.customHex }} />
          自定义{choice.preset === 'custom' ? <span aria-hidden="true" className="text-primary">✓</span> : null}
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          选择颜色
          <input
            aria-label="自定义主题色"
            type="color"
            value={choice.customHex}
            disabled={!loaded}
            onChange={event => void commit({ preset: 'custom', customHex: event.target.value.toUpperCase() })}
            className="h-9 w-12 cursor-pointer rounded-md border border-border bg-background p-1 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
        </label>
        <label className="flex w-36 flex-col gap-1.5 text-xs text-muted-foreground">
          十六进制颜色
          <Input
            aria-label="主题色十六进制值"
            aria-describedby="accent-color-hint"
            value={hexDraft}
            disabled={!loaded}
            spellCheck={false}
            maxLength={9}
            onChange={event => { setHexDraft(event.target.value); setError(null); }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyHex(); } }}
            placeholder="#7C3AED"
            className="font-mono uppercase"
          />
        </label>
        <Button type="button" variant="outline" size="md" disabled={!loaded} onClick={applyHex}>应用颜色</Button>
      </div>
      <p id="accent-color-hint" className="text-xs text-muted-foreground">支持 3 位或 6 位颜色值。文字和焦点颜色会随外观自动调整，保持清晰可读。</p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {status ? <p role="status" className="text-xs text-muted-foreground">{status}</p> : null}
    </div>
  );
}
