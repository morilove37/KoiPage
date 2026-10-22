import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode } from 'react';
import { CoverImage } from '@/components/ui/cover-image';
import { Button } from '@/components/ui/button';
import { centeredCoverCrop, cropFromDrag, effectiveCoverCrop, effectiveCoverPath, moveCoverCrop } from './model';
import type { CropRect } from './model';
import { updateCoverPreferences, useGameCover } from './store';

interface ImageSize { width: number; height: number }
interface Point { x: number; y: number }

/** Separate overlay and controls keep the existing large cover and detail layout intact. */
export function useCoverCropEditor({ gameId, sourcePath, title, dimensions }: {
  gameId: number; sourcePath: string | null; title: string;
  dimensions: (ImageSize & { path: string | null }) | null;
}): { overlay: ReactNode; controls: ReactNode } {
  const { preferences, loaded, saving, error: loadError } = useGameCover(gameId);
  const path = effectiveCoverPath(sourcePath, preferences);
  const size = dimensions?.path === path ? dimensions : null;
  const [draft, setDraft] = useState<(CropRect & { path: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const active = draft?.path === path ? draft : null;
  const crop = effectiveCoverCrop(sourcePath, preferences);
  useEffect(() => { setDraft(null); setError(null); setNotice(null); }, [gameId, path]);

  async function save(reset = false) {
    if (!reset && !active) return;
    setError(null); setNotice(null);
    try {
      await updateCoverPreferences(gameId, { crop: reset ? null : active });
      setDraft(null); setNotice(reset ? '已恢复游戏库默认展示范围。' : '游戏库封面展示范围已保存。');
    } catch (cause) { setError(String(cause)); }
  }

  return {
    overlay: active && size ? <CropOverlay size={size} crop={active} disabled={saving}
      onChange={next => setDraft({ ...next, path: active.path })} onCancel={() => { if (!saving) setDraft(null); }} /> : null,
    controls: <div className="flex flex-col gap-2" data-cover-crop-controls>
      {!active ? <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" disabled={!loaded || !path || !size || saving || Boolean(loadError)} onClick={() => {
          if (!path || !size) return;
          setError(null); setNotice(null); setDraft({ ...(crop ?? centeredCoverCrop(size)), path });
        }}>框选游戏库封面</Button>
        {crop ? <Button size="sm" variant="outline" disabled={saving} onClick={() => void save(true)}>恢复默认范围</Button> : null}
      </div> : <>
        <p className="text-xs text-muted-foreground">在上方大封面拖动框选，拖动选区移动，拖动右下角调整大小。按住 Shift 拖动可重新框选，比例固定为 3:4。</p>
        <div className="flex items-start gap-3">
          <div className="w-20 shrink-0">
            <div className="aspect-[3/4] overflow-hidden rounded border border-border bg-muted">
              <CoverImage path={path} censored={preferences.censored} crop={active} alt={`${title}的游戏库封面预览`} loading="eager" className="h-full w-full object-cover" />
            </div>
            <p className="mt-1 text-center text-[11px] text-muted-foreground">游戏库预览</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" disabled={saving || active.width < 0.01 || active.height < 0.01} onClick={() => void save()}>{saving ? '保存中…' : '保存范围'}</Button>
            <Button size="sm" variant="outline" disabled={saving} onClick={() => setDraft(null)}>取消</Button>
            <Button size="sm" variant="outline" disabled={saving} onClick={() => { if (size && path) setDraft({ ...centeredCoverCrop(size), path }); }}>重置选框</Button>
            {crop ? <Button size="sm" variant="outline" disabled={saving} onClick={() => void save(true)}>恢复默认范围</Button> : null}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">选区获得焦点后可用方向键移动，按住 Shift 加快；Esc 取消。仅改变游戏库卡片，保留原图。</p>
      </>}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-xs text-muted-foreground">{notice}</p> : null}
    </div>,
  };
}

function CropOverlay({ size, crop, disabled, onChange, onCancel }: {
  size: ImageSize; crop: CropRect; disabled: boolean; onChange: (crop: CropRect) => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0, left: 0, top: 0 });
  const drag = useRef<{ id: number; kind: 'draw' | 'move' | 'resize'; start: Point; crop: CropRect } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const scale = Math.min(element.clientWidth / size.width, element.clientHeight / size.height);
      const width = size.width * scale, height = size.height * scale;
      setBounds({ width, height, left: (element.clientWidth - width) / 2, top: (element.clientHeight - height) / 2 });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [size.width, size.height]);

  function point(event: PointerEvent): Point {
    const rect = ref.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top - bounds.top) / bounds.height)) };
  }
  function update(event: PointerEvent) {
    const current = drag.current;
    if (!current || current.id !== event.pointerId || disabled) return;
    const end = point(event);
    const next = current.kind === 'move' ? moveCoverCrop(current.crop, end.x - current.start.x, end.y - current.start.y)
      : cropFromDrag(current.kind === 'resize' ? { x: current.crop.x, y: current.crop.y } : current.start, end, size);
    // Ignore clicks and tiny drags so they cannot create a zero-sized preview.
    if (next.width >= 0.01 && next.height >= 0.01) onChange(next);
  }
  return <div ref={ref} className="absolute inset-0 touch-none select-none" style={{ cursor: disabled ? 'wait' : 'crosshair' }}
    onPointerDown={event => {
      if (disabled || event.button !== 0 || !bounds.width || drag.current) return;
      const rect = ref.current!.getBoundingClientRect();
      const px = event.clientX - rect.left, py = event.clientY - rect.top;
      if (px < bounds.left || px > bounds.left + bounds.width || py < bounds.top || py > bounds.top + bounds.height) return;
      event.preventDefault();
      const target = event.target as HTMLElement;
      const kind = event.shiftKey ? 'draw' : target.closest('[data-crop-resize]') ? 'resize' : target.closest('[data-crop-selection]') ? 'move' : 'draw';
      drag.current = { id: event.pointerId, kind, start: point(event), crop: { ...crop } };
      event.currentTarget.setPointerCapture(event.pointerId);
    }}
    onPointerMove={update}
    onPointerUp={event => { update(event); drag.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { const previous = drag.current; drag.current = null; if (previous) onChange(previous.crop); }}
    onLostPointerCapture={() => { drag.current = null; }}>
    <div className="absolute overflow-hidden" style={bounds}>
      <div data-crop-selection role="group" aria-label="游戏库封面选区，方向键移动" tabIndex={0}
        className="absolute cursor-move border-2 border-white outline-none focus-visible:border-primary"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%`, boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.55)' }}
        onKeyDown={event => {
          if (disabled) return;
          if (event.key === 'Escape') { event.preventDefault(); onCancel(); return; }
          const step = event.shiftKey ? 0.05 : 0.01;
          const moves: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
          if (moves[event.key]) { event.preventDefault(); onChange(moveCoverCrop(crop, ...moves[event.key])); }
        }}>
        <span className="pointer-events-none absolute inset-x-1/3 inset-y-0 border-x border-white/40" />
        <span className="pointer-events-none absolute inset-x-0 inset-y-1/3 border-y border-white/40" />
        <span data-crop-resize className="absolute -bottom-1 -right-1 h-5 w-5 cursor-nwse-resize rounded-sm border-2 border-white bg-primary" aria-hidden="true" />
      </div>
    </div>
  </div>;
}
