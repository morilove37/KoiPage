import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import { GeometryIcon } from '@/components/ui/geometry-icon';
import { coverSrc } from '@/lib/asset';
import { FolderTile } from './FolderTile';
import { contextMenuPosition, isContextMenuKey, nextMenuIndex } from './context-menu';
import { saveSocietyLogo, useSocietyLogo } from './society-logo-store';

function LogoImage({ path }: { path: string | null | undefined }) {
  const [failed, setFailed] = useState(false);
  return path && !failed ? <img src={coverSrc(path)} alt="" draggable={false} loading="lazy" onError={() => setFailed(true)}
    className="relative h-full w-full object-contain p-3" /> : <GeometryIcon name="folder" className="relative size-10 text-primary/60" />;
}

function LogoMenu({ name, point, custom, source, onAction, onClose }: {
  name: string; point: { x: number; y: number }; custom: boolean; source: string | null;
  onAction: (action: 'custom' | 'auto') => void; onClose: (focus?: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: point.x, top: point.y });
  useLayoutEffect(() => {
    if (menu.current) setPosition(contextMenuPosition(point, menu.current.getBoundingClientRect(), { width: innerWidth, height: innerHeight }));
    menu.current?.querySelector('button')?.focus();
  }, [point]);
  useEffect(() => {
    const outside = (event: Event) => { if (!menu.current?.contains(event.target as Node)) onClose(false); };
    const dismiss = () => onClose(false);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('contextmenu', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('scroll', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('scroll', outside, true);
    };
  }, [onClose]);
  return createPortal(<div ref={menu} role="menu" aria-label={`${name} Logo`} data-society-logo-menu
    className="fixed z-[70] w-48 rounded-lg border border-border bg-card p-1 text-xs text-foreground shadow-xl" style={position}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onKeyDown={event => {
      const buttons = [...menu.current!.querySelectorAll('button')];
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        const index = nextMenuIndex(buttons.map(() => ({ disabled: false })), buttons.indexOf(document.activeElement as HTMLButtonElement), event.key);
        buttons[index]?.focus();
      } else if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); onClose(); }
    }}>
    <p className="truncate px-2.5 py-1.5 text-muted-foreground">{name}</p>
    <button role="menuitem" className="w-full rounded px-2.5 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => onAction('custom')}>设置 Logo…</button>
    <button role="menuitem" className="w-full rounded px-2.5 py-2 text-left hover:bg-accent focus:bg-accent focus:outline-none" onClick={() => onAction('auto')}>{custom ? '恢复自动获取' : '重新获取 Logo'}</button>
    {source ? <p className="border-t border-border px-2.5 pt-2 pb-1 text-[11px] text-muted-foreground">Logo：{source === 'nextmoe' ? '鲲 Galgame 论坛' : source === 'bangumi' ? 'Bangumi' : source === 'wikidata' ? 'Wikidata / Commons' : '自定义图片'}</p> : null}
  </div>, document.body);
}

export function SocietyFolderTile({ name, value, count, onClick }: { name: string; value: string; count: number; onClick: () => void }) {
  const { logo, saving, error } = useSocietyLogo(value);
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const close = (focus = true) => { setPoint(null); if (focus) root.current?.querySelector('button')?.focus(); };
  const action = async (id: 'custom' | 'auto') => {
    close();
    setPickerError(null);
    try {
      if (id === 'auto') { await saveSocietyLogo(value, null); return; }
      const path = await open({ title: `设置 ${name} Logo`, multiple: false, filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }] });
      if (typeof path === 'string') await saveSocietyLogo(value, path);
    } catch (cause) { setPickerError(String(cause)); }
  };
  return <div ref={root} className="group relative min-w-0" data-society-logo-trigger={value || undefined}
    onContextMenu={event => { if (value && !saving) { event.preventDefault(); event.stopPropagation(); setPoint({ x: event.clientX, y: event.clientY }); } }}
    onKeyDown={event => { if (value && !saving && isContextMenuKey(event)) { event.preventDefault(); event.stopPropagation(); const bounds = root.current!.getBoundingClientRect(); setPoint({ x: bounds.left + 16, y: bounds.top + 30 }); } }}>
    <FolderTile name={name} count={count} onClick={onClick} artwork={<span className="relative flex h-24 w-full items-center justify-center pt-2" aria-hidden="true">
      <span className="absolute left-0 top-0 h-5 w-16 rounded-t-lg border border-b-0 border-primary/20 bg-primary/10" />
      <span className="absolute inset-x-0 bottom-0 top-2 rounded-lg rounded-tl-none border border-primary/20 bg-primary/5" />
      <LogoImage key={logo?.path ?? ''} path={logo?.path} />
    </span>} />
    {value ? <button type="button" disabled={saving} aria-label={`设置 ${name} Logo`} title="设置 Logo"
      className="absolute right-2 top-2 rounded px-2 py-0.5 text-sm text-muted-foreground opacity-0 hover:bg-accent focus:opacity-100 group-hover:opacity-100 disabled:opacity-30"
      onClick={event => { const bounds = event.currentTarget.getBoundingClientRect(); setPoint({ x: bounds.right, y: bounds.bottom }); }}>···</button> : null}
    {error || pickerError ? <p role="alert" className="mt-1 break-words text-xs text-destructive">{error || pickerError}</p> : null}
    {point ? <LogoMenu name={name} point={point} custom={logo?.custom ?? false} source={logo?.source ?? null} onAction={id => void action(id)} onClose={close} /> : null}
  </div>;
}
