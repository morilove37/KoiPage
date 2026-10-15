import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { id: 'settings-scan', label: '扫描目录' },
  { id: 'settings-appearance', label: '外观' },
  { id: 'settings-localization', label: '资料汉化' },
  { id: 'settings-launch', label: '启动设置' },
  { id: 'settings-data', label: '数据管理' },
  { id: 'settings-about', label: '关于' },
] as const;

export type SettingsSectionId = typeof SECTIONS[number]['id'];

/** Anchor navigation tracks the app's main scroller, including async resizing. */
export function SettingsSectionNav() {
  const [activeId, setActiveId] = useState<SettingsSectionId>(SECTIONS[0].id);
  const navRef = useRef<HTMLElement>(null);
  // Several short sections can share the same clamped scroll destination near
  // the bottom. Keep the clicked item selected until the user scrolls again.
  const jumpRef = useRef<{ top: number; settled: boolean } | null>(null);

  useEffect(() => {
    const nav = navRef.current;
    const scroller = nav?.closest('main');
    if (!nav || !scroller) return;
    const sections = SECTIONS.map(item => document.getElementById(item.id));
    let frame = 0;

    const update = () => {
      frame = 0;
      const jump = jumpRef.current;
      if (jump) {
        if (Math.abs(scroller.scrollTop - jump.top) <= 2) { jump.settled = true; return; }
        if (!jump.settled) return;
        jumpRef.current = null;
      }
      const maximum = scroller.scrollHeight - scroller.clientHeight;
      if (maximum > 1 && scroller.scrollTop >= maximum - 2) {
        setActiveId(SECTIONS[SECTIONS.length - 1].id);
        return;
      }
      const stickyTop = Number.parseFloat(getComputedStyle(nav).top) || 0;
      const readingLine = scroller.getBoundingClientRect().top + stickyTop + nav.offsetHeight + 16;
      let next: SettingsSectionId = SECTIONS[0].id;
      sections.forEach((section, index) => {
        if (section && section.getBoundingClientRect().top <= readingLine + 1) next = SECTIONS[index].id;
      });
      setActiveId(next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    const resumeTracking = () => { jumpRef.current = null; schedule(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) resumeTracking();
    };
    scroller.addEventListener('scroll', schedule, { passive: true });
    scroller.addEventListener('wheel', resumeTracking, { passive: true });
    scroller.addEventListener('touchstart', resumeTracking, { passive: true });
    scroller.addEventListener('pointerdown', resumeTracking, { passive: true });
    scroller.addEventListener('keydown', onKeyDown);
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(nav);
    sections.forEach(section => { if (section) observer.observe(section); });
    schedule();
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      scroller.removeEventListener('scroll', schedule);
      scroller.removeEventListener('wheel', resumeTracking);
      scroller.removeEventListener('touchstart', resumeTracking);
      scroller.removeEventListener('pointerdown', resumeTracking);
      scroller.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  function goTo(id: SettingsSectionId) {
    const nav = navRef.current;
    const scroller = nav?.closest('main');
    const section = document.getElementById(id);
    if (!nav || !scroller || !section) return;
    const stickyTop = Number.parseFloat(getComputedStyle(nav).top) || 0;
    const offset = stickyTop + nav.offsetHeight + 16;
    const desired = scroller.scrollTop + section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
    const top = Math.max(0, Math.min(desired, scroller.scrollHeight - scroller.clientHeight));
    jumpRef.current = { top, settled: Math.abs(scroller.scrollTop - top) <= 2 };
    setActiveId(id);
    scroller.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  const activeIndex = SECTIONS.findIndex(item => item.id === activeId);
  return (
    <nav ref={navRef} aria-label="设置分区导航"
      className="sticky top-0 z-20 shrink-0 rounded-xl border border-border bg-background/95 p-1 shadow-sm backdrop-blur-md [.glass_&]:bg-[hsl(var(--glass-strong))]">
      <div className="relative grid grid-cols-6">
        <span aria-hidden="true" data-settings-slider
          className="sidebar-slider pointer-events-none absolute inset-y-0 left-0"
          style={{ width: `${100 / SECTIONS.length}%`, transform: `translateX(${activeIndex * 100}%)` }} />
        {SECTIONS.map(item => <a key={item.id} href={`#${item.id}`}
          aria-current={activeId === item.id ? 'location' : undefined}
          onClick={event => { event.preventDefault(); goTo(item.id); }}
          className={cn('relative z-10 flex h-9 min-w-0 items-center justify-center rounded-lg px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm',
            activeId === item.id ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground')}>
          {item.label}
        </a>)}
      </div>
    </nav>
  );
}
