import type { SVGProps } from "react";
import { cn } from "@/lib/utils";

export type GeometryIconName = "home" | "library" | "tools" | "tags" | "settings" | "clock" | "play" | "check" | "bookmark" | "calendar" | "chart" | "stop" | "history" | "cake";

/** Small geometric glyphs share the text color and a consistent 24px grid. */
export function GeometryIcon({ name, className, ...props }: SVGProps<SVGSVGElement> & { name: GeometryIconName }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={cn("size-[18px] shrink-0", className)} {...props}>
      {name === "cake" ? <><path d="M4 12h16v9H4ZM3 21h18M8 12V9h8v3M12 9V6" /><path d="M4 15c2 3 4-2 6 0s4-2 6 0 3 1 4 0M12 5c-2-1-1-3 0-4 1 1 2 3 0 4Z" /></> : null}
      {name === "home" ? <><path d="m3.5 10 8.5-7 8.5 7v10h-17Z" /><path d="M9 20v-7h6v7" /><path d="m12 3 8.5 7h-17Z" fill="currentColor" opacity=".14" stroke="none" /></> : null}
      {name === "library" ? <><rect x="3" y="4" width="5" height="16" rx="1" /><rect x="10" y="4" width="4" height="16" rx="1" /><path d="m16 5 4-1 3 15-4 1Z" /><path d="M4.5 8h2M11 15h2" /><path d="M3 16h5v4H3Z" fill="currentColor" opacity=".14" stroke="none" /></> : null}
      {name === "tools" ? <><path d="M14.5 4.5a4.5 4.5 0 0 0-5.7 5.7L4 15v5h5l4.8-4.8a4.5 4.5 0 0 0 5.7-5.7l-3 3-2.5-2.5Z" /><path d="M4 16h4v4H4Z" fill="currentColor" opacity=".14" stroke="none" /></> : null}
      {name === "tags" ? <><path d="M3 4h8l10 10-8 8L3 12Z" /><circle cx="7.5" cy="8.5" r="1.5" /><path d="m14 6 8 8" opacity=".45" /></> : null}
      {name === "settings" ? <><path d="m12 2.5 8.2 4.75v9.5L12 21.5l-8.2-4.75v-9.5Z" /><circle cx="12" cy="12" r="4" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /></> : null}
      {name === "clock" ? <><circle cx="12" cy="12" r="9" /><path d="M12 6.5V12l3.5 2" /><path d="M12 3a9 9 0 0 1 9 9h-9Z" fill="currentColor" opacity=".12" stroke="none" /></> : null}
      {name === "play" ? <><path d="m8 4 12 8-12 8Z" /><path d="m8 4 12 8-12 8Z" fill="currentColor" opacity=".14" stroke="none" /><path d="M4 5v14" opacity=".5" /></> : null}
      {name === "check" ? <><path d="m12 2 10 10-10 10L2 12Z" /><path d="m8 12 3 3 5-6" /></> : null}
      {name === "bookmark" ? <><path d="M6 3h12v18l-6-4-6 4Z" /><path d="M9 7h6M9 10h4" /><path d="M6 3h12v4H6Z" fill="currentColor" opacity=".14" stroke="none" /></> : null}
      {name === "calendar" ? <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h2M15 14h2M7 17h2" /></> : null}
      {name === "chart" ? <><path d="M3 3v18h18" /><rect x="6" y="12" width="3" height="6" rx=".5" /><rect x="12" y="8" width="3" height="10" rx=".5" /><rect x="18" y="4" width="3" height="14" rx=".5" /></> : null}
      {name === "stop" ? <><rect x="4" y="4" width="16" height="16" rx="4" /><rect x="9" y="9" width="6" height="6" rx=".5" fill="currentColor" stroke="none" /></> : null}
      {name === "history" ? <><path d="M4 8a9 9 0 1 1-1 8M3 3v6h6" /><path d="M12 7v5l3 2" /></> : null}
    </svg>
  );
}
