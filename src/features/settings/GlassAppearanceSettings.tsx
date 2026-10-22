import { useEffect, useRef, useState } from 'react';
import { settingsGet, settingsSet } from '@/lib/db';
import { applyGlassAppearance, DEFAULT_GLASS_APPEARANCE, GLASS_BLUR_KEY, GLASS_OPACITY_KEY, parseGlassAppearance } from '@/lib/glass-appearance';
import type { GlassAppearance } from '@/lib/glass-appearance';

export async function initGlassAppearance(): Promise<GlassAppearance> {
  const [opacity, blur] = await Promise.all([settingsGet(GLASS_OPACITY_KEY), settingsGet(GLASS_BLUR_KEY)]);
  const appearance = parseGlassAppearance(opacity, blur);
  applyGlassAppearance(appearance);
  return appearance;
}

export function GlassAppearanceSettings() {
  const [appearance, setAppearance] = useState<GlassAppearance>({ ...DEFAULT_GLASS_APPEARANCE });
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef(appearance);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => {
    let alive = true;
    void initGlassAppearance().then(value => {
      if (alive) { current.current = value; setAppearance(value); setLoaded(true); }
    }).catch(cause => { if (alive) setError(String(cause)); });
    return () => { alive = false; };
  }, []);

  function change(patch: Partial<GlassAppearance>) {
    const next = { ...current.current, ...patch };
    current.current = next;
    setAppearance(next);
    applyGlassAppearance(next);
    setError(null);
    // Serialize full snapshots so rapid dragging cannot persist an older value last.
    writes.current = writes.current.catch(() => {}).then(async () => {
      if (current.current !== next) return;
      await settingsSet(GLASS_OPACITY_KEY, String(next.opacity));
      await settingsSet(GLASS_BLUR_KEY, String(next.blur));
    }).catch(cause => setError(`外观设置保存失败：${String(cause)}`));
  }

  return <div className="mt-5 border-t border-border pt-4" data-glass-appearance>
    <h3 className="text-sm font-medium">玻璃面板</h3>
    <p className="mt-1 text-xs text-muted-foreground">直接调节卡片、侧栏和弹窗，无需设置背景图片。面板不透明度越高，透底越少。</p>
    <div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <span className="flex justify-between"><span>玻璃面板不透明度</span><span className="tabular-nums text-foreground">{appearance.opacity}%</span></span>
        <input aria-label="玻璃面板不透明度" type="range" min="40" max="100" step="1" value={appearance.opacity} disabled={!loaded}
          onChange={event => change({ opacity: Number(event.target.value) })} className="w-full cursor-pointer accent-primary" />
        <span>100% 为不透底；默认 72%。</span>
      </label>
      <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
        <span className="flex justify-between"><span>玻璃磨砂强度</span><span className="tabular-nums text-foreground">{appearance.blur}px</span></span>
        <input aria-label="玻璃磨砂强度" type="range" min="0" max="60" step="1" value={appearance.blur} disabled={!loaded}
          onChange={event => change({ blur: Number(event.target.value) })} className="w-full cursor-pointer accent-primary" />
        <span>数值越高，面板后方的背景越模糊。</span>
      </label>
    </div>
    <button type="button" disabled={!loaded} className="mt-3 text-xs text-primary hover:underline" onClick={() => change(DEFAULT_GLASS_APPEARANCE)}>恢复默认玻璃效果</button>
    {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
  </div>;
}
