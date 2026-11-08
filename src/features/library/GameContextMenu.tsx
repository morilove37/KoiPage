import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { contextMenuPosition, nextMenuIndex, restoreFocusAfterOutsideClick } from './context-menu';
import type { GameContextAction, GameContextActionId } from './context-menu';

interface Props {
  title: string;
  point: { x: number; y: number };
  actions: readonly GameContextAction[];
  onAction: (id: GameContextActionId) => void;
  onClose: (restoreFocus?: boolean) => void;
}

export function GameContextMenu({ title, point, actions, onAction, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: point.x, top: point.y });
  const [active, setActive] = useState(() => nextMenuIndex(actions, -1, 'Home'));
  const activated = useRef(false);
  const focusItem = (index: number) => {
    if (index < 0) { menuRef.current?.focus(); return; }
    menuRef.current?.querySelector<HTMLElement>(`[data-menu-index="${index}"]`)?.focus();
    setActive(index);
  };

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const bounds = menu.getBoundingClientRect();
    setPosition(contextMenuPosition(point, bounds, { width: window.innerWidth, height: window.innerHeight }));
    focusItem(nextMenuIndex(actions, -1, 'Home'));
    // The menu remounts for each invocation, preserving focus while live process state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        onClose(restoreFocusAfterOutsideClick(event.target instanceof Element ? event.target : null, event.button));
      }
    };
    const dismiss = () => onClose();
    const scroll = (event: Event) => { if (!menuRef.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('contextmenu', outside, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    window.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('contextmenu', outside, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      window.removeEventListener('scroll', scroll, true);
    };
  }, [onClose]);

  const activate = (action: GameContextAction) => {
    if (action.disabled || activated.current) return;
    activated.current = true;
    onClose();
    onAction(action.id);
  };

  return createPortal(<div
    ref={menuRef}
    role="menu"
    aria-label={title}
    tabIndex={-1}
    data-game-context-menu
    className="fixed z-[70] w-64 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-border bg-card p-1 text-sm text-foreground shadow-2xl outline-none"
    style={{ ...position, maxHeight: 'calc(100vh - 1rem)' }}
    onContextMenu={event => { event.preventDefault(); event.stopPropagation(); }}
    onClick={event => event.stopPropagation()}
    onKeyDown={event => {
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation();
        focusItem(nextMenuIndex(actions, active, event.key));
      } else if (event.key === 'Escape' || event.key === 'Tab') {
        event.preventDefault(); event.stopPropagation(); onClose();
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopPropagation();
        if (actions[active]) activate(actions[active]);
      }
    }}
  >
    <p className="truncate px-2.5 py-1.5 text-xs font-medium text-muted-foreground" title={title}>{title}</p>
    {actions.map((action, index) => <div key={action.id}>
      {index > 0 && actions[index - 1].group !== action.group ? <div role="separator" className="my-1 border-t border-border" /> : null}
      {action.group === 'status' && (index === 0 || actions[index - 1].group !== 'status') ? <p className="px-2.5 pb-1 pt-0.5 text-[11px] text-muted-foreground">游玩状态</p> : null}
      <button
        type="button"
        role={action.group === 'status' ? 'menuitemradio' : 'menuitem'}
        aria-checked={action.group === 'status' ? Boolean(action.checked) : undefined}
        aria-disabled={action.disabled || undefined}
        disabled={action.disabled}
        title={action.hint}
        tabIndex={active === index ? 0 : -1}
        data-menu-index={index}
        data-menu-action={action.id}
        className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs outline-none hover:bg-accent focus:bg-accent focus:text-accent-foreground disabled:cursor-default disabled:opacity-40', action.checked && 'text-primary')}
        onFocus={() => setActive(index)}
        onClick={() => activate(action)}
      >
        {action.group === 'status' ? <span className="w-3 text-center" aria-hidden="true">{action.checked ? '✓' : ''}</span> : null}
        <span>{action.label}</span>
      </button>
    </div>)}
  </div>, document.body);
}
