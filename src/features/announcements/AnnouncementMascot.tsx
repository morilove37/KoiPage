import { useId, useRef, useState } from "react";

/** A small greeting shared by both announcements and the author information. */
export function AnnouncementMascot() {
  const [open, setOpen] = useState(false);
  const bubbleId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return <div className="relative w-24 shrink-0 self-end sm:w-28"
    onKeyDown={event => {
      if (open && event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    }}>
    {open ? <div id={bubbleId} role="note" aria-label="水无月萤的气泡"
      className="absolute bottom-full right-0 z-10 mb-2 w-40 max-w-[calc(100vw-5rem)] rounded-2xl border border-primary/25 bg-card p-4 text-sm text-card-foreground shadow-lg">
      <button type="button" aria-label="收起气泡" onClick={close}
        className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">×</button>
      <p className="pr-5 font-semibold text-primary">呀吼——</p>
      <span aria-hidden="true" className="absolute -bottom-[5px] right-10 h-2 w-2 rotate-45 border-b border-r border-primary/25 bg-card" />
    </div> : null}
    <button ref={trigger} type="button" aria-label="水无月萤：发现一个小彩蛋" aria-expanded={open} aria-controls={open ? bubbleId : undefined}
      onClick={() => setOpen(value => !value)}
      className="block aspect-square w-full rounded-xl transition-transform hover:-translate-x-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card motion-reduce:transform-none motion-reduce:transition-none">
      <img src="/announcements/hotaru-peek.png" alt="" width={1280} height={1280} draggable={false}
        className="pointer-events-none h-full w-full object-contain" />
    </button>
  </div>;
}
