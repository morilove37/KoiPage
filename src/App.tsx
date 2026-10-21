import { lazy, Suspense, useEffect } from "react";
import { NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "@/components/ui/error-boundary";
import { GithubProfileLink } from "@/components/ui/github-profile-link";
import { GeometryIcon } from "@/components/ui/geometry-icon";
import type { GeometryIconName } from "@/components/ui/geometry-icon";
import { cn } from "@/lib/utils";
import { loadBackdrop, syncBackdrop } from "@/lib/backdrop";
import { syncAssetScope } from "@/lib/db";
import { loadLocalizationPreference } from "@/lib/localization";
import { BRAND } from "@/lib/brand";
import { UpdateDialog } from "@/features/updates/UpdateDialog";
import { AnnouncementDialog } from "@/features/announcements/AnnouncementDialog";
import { BirthdayCelebrationDialog } from "@/features/birthdays/BirthdayCelebrationDialog";
import { CloseBehaviorDialog } from "@/features/window/CloseBehaviorDialog";
import { useGameProcessSync } from "@/features/launch/useGameProcess";

/**
 * Application shell: sidebar navigation + routed page area.
 *
 * Page components are owned by the feature teams and are loaded lazily so a
 * missing page does not take down the whole shell during development.
 *
 * Route map (keep in sync with the sidebar links below):
 *   /home             首页
 *   /library          游戏库
 *   /library/:id      游戏详情
 *   /tools            实用工具
 *   /tags             标签管理
 *   /settings         设置
 */

const HomePage = lazy(() => import("@/features/home/HomePage"));
const LibraryPage = lazy(() => import("@/features/library/LibraryPage"));
const GameDetailPage = lazy(() => import("@/features/detail/GameDetailPage"));
const ToolsPage = lazy(() => import("@/features/tools/ToolsPage"));
const TagsPage = lazy(() => import("@/features/tags/TagsPage"));
const SettingsPage = lazy(() => import("@/features/settings/SettingsPage"));

interface NavItem {
  to: string;
  label: string;
  icon: GeometryIconName;
  /** Match nested routes (e.g. /library/12) as active too. */
  prefix?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: "/home", label: "首页", icon: "home" },
  { to: "/library", label: "游戏库", icon: "library", prefix: true },
  { to: "/tools", label: "实用工具", icon: "tools" },
  { to: "/tags", label: "标签管理", icon: "tags" },
  { to: "/settings", label: "设置", icon: "settings" },
];

function PageFallback() {
  return (
    <div className="flex h-full items-center justify-center text-muted-foreground">
      加载中…
    </div>
  );
}

export default function App() {
  useGameProcessSync();
  const { pathname } = useLocation();
  const activeNavIndex = Math.max(0, NAV_ITEMS.findIndex(item =>
    item.prefix ? pathname.startsWith(item.to) : pathname === item.to,
  ));

  useEffect(() => {
    // Capture before React and portal handlers: right-clicking a dialog scrim
    // must not dismiss it, and the WebView context menu must stay closed.
    const blockRightClick = (event: MouseEvent) => {
      if (event.type !== "contextmenu" && event.button !== 2) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const events = ["contextmenu", "pointerdown", "pointerup", "mousedown", "mouseup", "auxclick"] as const;
    for (const name of events) window.addEventListener(name, blockRightClick, { capture: true, passive: false });
    return () => {
      for (const name of events) window.removeEventListener(name, blockRightClick, true);
    };
  }, []);

  // Runtime scope is not persisted; restore access to saved cover files and to
  // the stored glass wallpaper (`main.tsx` already granted the latter before the
  // first paint — this is a cheap idempotent top-up for the case where the shell
  // mounted without that bootstrap succeeding).
  useEffect(() => {
    void loadLocalizationPreference().catch(cause => console.warn("[localization] settings:", cause));
    syncAssetScope().catch((cause) => {
      console.warn("[asset-scope] sync failed:", cause);
    });
    void (async () => {
      try {
        const stored = await loadBackdrop();
        syncBackdrop(stored.path);
      } catch (cause) {
        console.warn("[backdrop] sync failed:", cause);
      }
    })();
  }, []);

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <aside className="app-sidebar flex w-52 shrink-0 flex-col border-r border-border bg-card">
        <div className="flex h-14 shrink-0 items-center gap-2.5 px-4" aria-label={BRAND.title}>
          <img src={BRAND.icon} alt="" aria-hidden="true" className="h-9 w-9 shrink-0" width={36} height={36} />
          <div className="min-w-0">
            <p className="text-lg font-semibold leading-6 tracking-[0.12em]">{BRAND.name}</p>
            <p className="text-[9px] font-medium leading-3 tracking-[0.12em] text-muted-foreground">KOIPAGE · GALGAME</p>
          </div>
        </div>

        <nav className="relative flex flex-1 flex-col gap-1 p-2" aria-label="主导航">
          <span
            aria-hidden="true"
            className="sidebar-slider pointer-events-none absolute left-2 right-2 top-2 h-9"
            style={{ transform: `translateY(${activeNavIndex * 40}px)` }}
          />
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "relative z-10 flex h-9 shrink-0 items-center gap-2.5 rounded-md px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive ||
                    (item.prefix && pathname.startsWith(item.to))
                    ? "text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                )
              }
            >
              <GeometryIcon name={item.icon} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="flex min-w-0 items-center gap-2 border-t border-border px-4 py-3 text-xs text-muted-foreground">
          <span className="shrink-0">v{BRAND.version}</span>
          <span aria-hidden="true">·</span>
          <GithubProfileLink className="truncate text-muted-foreground transition-colors hover:text-primary" />
        </div>
      </aside>

      {/* `key={pathname}` forces a remount per route so the enter animation
          replays on navigation — without it React reuses the DOM node and the
          animation only ever runs once. It also resets the error boundary
          below, so a page that failed once is retried on the next visit. */}
      <main key={pathname} className={cn("flex-1 overflow-y-auto", !/^\/library\/[^/]+$/.test(pathname) && "animate-page")}>
        {/*
          A render error anywhere in a route is caught here and rendered in
          place. Without this, one broken component unmounts the whole tree and
          the window goes blank — the failure mode behind "点进去白茫茫一片".
        */}
        <ErrorBoundary label="这个页面">
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<Navigate to="/home" replace />} />
              <Route path="/home" element={<HomePage />} />
              <Route path="/library" element={<LibraryPage />} />
              <Route path="/library/:id" element={<GameDetailPage />} />
              <Route path="/tools" element={<ToolsPage />} />
              <Route path="/tags" element={<TagsPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/home" replace />} />
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </main>
      <UpdateDialog />
      <AnnouncementDialog />
      <BirthdayCelebrationDialog />
      <CloseBehaviorDialog />
    </div>
  );
}
