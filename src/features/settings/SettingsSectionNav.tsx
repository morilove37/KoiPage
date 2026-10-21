import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

const SECTIONS = [
  { id: 'settings-scan', label: '扫描目录' },
  { id: 'settings-appearance', label: '外观' },
  { id: 'settings-window', label: '窗口' },
  { id: 'settings-localization', label: '资料汉化' },
  { id: 'settings-metadata', label: '资料匹配' },
  { id: 'settings-birthdays', label: '角色生日' },
  { id: 'settings-data', label: '数据管理' },
  { id: 'settings-paths', label: '游戏路径' },
  { id: 'settings-logs', label: '日志' },
  { id: 'settings-announcements', label: '公告' },
  { id: 'settings-about', label: '关于' },
] as const;

export type SettingsSectionId = typeof SECTIONS[number]['id'];

/** Space kept between the viewport top and the section it jumps to. */
const JUMP_OFFSET = 24;

/**
 * Vertical anchor navigation for the settings page.
 *
 * It sits in the left column of the page (the empty gutter beside the content)
 * and stays pinned while the main scroller moves. Tracking remains anchored to
 * the app's `main` scroller, including async resizing.
 */
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
      // A section counts as current once its top reaches the reading line a
      // little below the viewport top. The nav is vertical now, so its own
      // height must not push that line down.
      const readingLine = scroller.getBoundingClientRect().top + JUMP_OFFSET;
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
    const desired = scroller.scrollTop + section.getBoundingClientRect().top - scroller.getBoundingClientRect().top - JUMP_OFFSET;
    const top = Math.max(0, Math.min(desired, scroller.scrollHeight - scroller.clientHeight));
    jumpRef.current = { top, settled: Math.abs(scroller.scrollTop - top) <= 2 };
    setActiveId(id);
    scroller.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }

  return (
    <nav ref={navRef} aria-label="设置分区导航"
      className="flex w-full flex-col gap-0.5"
    >
      {SECTIONS.map(item => (
        <a key={item.id} href={`#${item.id}`}
          aria-current={activeId === item.id ? 'location' : undefined}
          onClick={event => { event.preventDefault(); goTo(item.id); }}
          className={cn(
            'relative flex h-9 min-w-0 items-center rounded-lg px-3 text-sm font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            activeId === item.id
              ? 'bg-primary text-primary-foreground'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground',
          )}>
          {item.label}
        </a>
      ))}
    </nav>
  );
}
