/**
 * 设置页 — `/settings`.
 *
 * Sections, each self-contained so a failure in one (e.g. no database yet)
 * does not blank the whole page:
 *
 *   1. 扫描根管理 — list / add / delete / enable / maxDepth
 *   2. 外观      — light / dark / system, persisted to the `settings` table
 *   3. 资料汉化  — offline tag dictionary switch
 *   4. 数据管理  — backup / export / import
 *   5. 公告      — re-open the welcome / release announcements
 *   6. 关于      — version and project links
 *
 * The locale tool ("转区工具") and the Magpie window-scaling tool live on the
 * dedicated 实用工具 page (`/tools`), not here.
 *
 * Data access goes through `@/lib/db` (which awaits the connection and
 * migrations) and `@/features/io/io` (launcher commands). Command failures
 * reject with a **plain string**, so every `catch` uses `errorMessage`.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { open, save } from '@tauri-apps/plugin-dialog';

import {
  scanRootCreate,
  scanRootDelete,
  scanRootsList,
  scanRootUpdate,
  settingsGet,
  settingsGetAll,
  settingsSet,
  syncAssetScope,
} from '@/lib/db';
import { COVER_SETTING_PREFIX, parseCoverPreferences } from '@/features/covers/model';
import type { ScanRoot } from '@/types/game';
import { cn } from '@/lib/utils';
import { BRAND } from '@/lib/brand';
import { LegalDocuments } from '@/features/legal/LegalDocuments';
import { loadLocalizationPreference, OFFLINE_TAG_COUNT, setLocalizationEnabled, useLocalizationStore } from '@/lib/localization';
import {
  TITLE_LANGUAGE_KEY,
  ALL_PROVIDERS,
  PROVIDER_LABELS,
  normalizeTitlePreference,
  type MetadataTitlePreference,
} from '@/features/metadata/fields';
import { MetadataRefreshPanel } from '@/features/metadata/MetadataRefreshPanel';
import { SearchSourcesSettings } from '@/features/metadata/SearchSourcesSettings';
import { DEFAULT_SOURCE_KEY, normalizeDefaultSource } from '@/features/metadata/preferences';
import type { MetadataProvider } from '@/lib/db';
import {
  CLOSE_BEHAVIOR_KEY,
  CLOSE_BEHAVIOR_OPTIONS,
  normalizeCloseBehavior,
  type CloseBehavior,
} from '@/features/window/close-behavior';
import {
  DEFAULT_THEME,
  THEMES,
  THEME_DESCRIPTIONS,
  THEME_LABELS,
  type Theme,
  applyTheme,
  isGlassTheme,
  loadTheme,
  setTheme as persistTheme,
} from '@/lib/theme';
import {
  BACKDROP_BLUR_RANGE,
  BACKDROP_FIT_DESCRIPTIONS,
  BACKDROP_FIT_LABELS,
  BACKDROP_FITS,
  BACKDROP_OPACITY_RANGE,
  DEFAULT_BACKDROP,
  type BackdropSettings,
  applyBackdrop,
  backdropAssetGrant,
  backdropSrc,
  loadBackdrop,
  saveBackdrop,
} from '@/lib/backdrop';
import { Skeleton } from '@/components/ui/skeleton';
import { Select } from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/dialog';
import { CoverImage } from '@/components/ui/cover-image';
import { friendsCoverStatus, friendsDeleteAccount, friendsResumeDeletion, friendsStatus } from '@/features/friends/api';
import { useFriendsStore } from '@/features/friends/store';
import type { Account, CoverStatus } from '@/features/friends/types';
import { GithubProfileLink } from '@/components/ui/github-profile-link';
import { UpdateSettings } from '@/features/updates/UpdateSettings';
import { AnnouncementSettings } from '@/features/announcements/AnnouncementSettings';
import { BangumiSyncSettings } from '@/features/bangumi-sync/BangumiSyncSettings';
import { BirthdayReminderSettings } from '@/features/birthdays/BirthdayReminderSettings';
import { useScanFolderTip } from '@/features/scan/ScanFolderTip';
import { SettingsSectionNav } from './SettingsSectionNav';
import { BackupPanel } from '@/features/backup/BackupPanel';
import { PathRepairPanel } from './PathRepairPanel';
import { AnnouncementContact } from '@/features/announcements/AnnouncementContact';
import { AccentSettings } from './AccentSettings';
import { GlassAppearanceSettings } from './GlassAppearanceSettings';
import { LogSettings } from './LogSettings';
import type { SettingsSectionId } from './SettingsSectionNav';
import {
  type ExportFormat,
  backupDatabase,
  baseName,
  defaultExportFileName,
  errorMessage,
  exportGames,
  importGames,
} from '@/features/io/io';

// ---------------------------------------------------------------------------
// Small shared UI pieces
// ---------------------------------------------------------------------------

function Section({
  id,
  title,
  description,
  children,
}: {
  /** Nav literals keep autocomplete; the extra sections are not listed in the nav yet. */
  id: SettingsSectionId | (string & {});
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className={cn(
        'rounded-lg border border-border bg-card p-5',
        // Glass theme: the whole settings card is a frosted pane. The ancestor
        // rule in index.css already handles `bg-card`; these add the heavier
        // frost, the specular top edge and the roomier radius.
        '[.glass_&]:rounded-xl [.glass_&]:bg-[hsl(var(--glass))]',
        '[.glass_&]:backdrop-blur-glass [.glass_&]:backdrop-saturate-150',
        '[.glass_&]:shadow-[inset_0_1px_0_0_hsl(var(--glass-highlight)),0_12px_36px_-14px_var(--glass-shadow)]',
      )}
    >
      <header className="mb-4">
        <h2 id={`${id}-heading`} className="text-base font-semibold">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/** Inline status line. `tone` picks the colour; `null` renders nothing. */
function Status({
  tone,
  children,
}: {
  tone: 'ok' | 'error' | 'info';
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'text-sm',
        tone === 'ok' && 'text-emerald-500',
        tone === 'error' && 'text-destructive',
        tone === 'info' && 'text-muted-foreground',
      )}
    >
      {children}
    </p>
  );
}

function Button({
  children,
  onClick,
  disabled,
  variant = 'default',
  type = 'button',
  title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  type?: 'button' | 'submit';
  title?: string;
}) {
  return (
    <button
      type={type}
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'rounded-md px-3 py-1.5 text-sm tap disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' &&
          'bg-primary text-primary-foreground hover:opacity-90 [.glass_&]:bg-primary/85 [.glass_&]:backdrop-blur-md',
        variant === 'default' &&
          'border border-border bg-background hover:bg-accent hover:text-accent-foreground [.glass_&]:bg-white/5 [.glass_&]:backdrop-blur-md',
        variant === 'danger' &&
          'border border-destructive/40 text-destructive hover:bg-destructive/10 [.glass_&]:backdrop-blur-sm',
        variant === 'ghost' &&
          'text-muted-foreground hover:bg-accent hover:text-accent-foreground [.glass_&]:backdrop-blur-sm',
      )}
    >
      {children}
    </button>
  );
}

/** Placeholder rows shown while the scan-root list is loading. */
function SkeletonScanRoots() {
  return (
    <div className="space-y-2" aria-busy="true">
      <span className="sr-only">正在加载扫描根…</span>
      {[0, 1].map((index) => (
        <div
          key={index}
          className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
        >
          <Skeleton variant="shimmer" className="h-3.5 min-w-0 flex-1" />
          <Skeleton className="h-4 w-14" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-7 w-14 rounded-md" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1. Scan roots
// ---------------------------------------------------------------------------

function ScanRootsSection() {
  const [roots, setRoots] = useState<ScanRoot[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const scanFolderTip = useScanFolderTip();

  const reload = useCallback(async () => {
    try {
      setRoots(await scanRootsList());
      setError(null);
      // Scan roots define where cover images may be read from. The asset scope
      // is not persisted, so re-grant it whenever the root list changes —
      // otherwise covers keep rendering as placeholders until an app restart.
      try {
        await syncAssetScope();
      } catch (scopeError) {
        console.warn('[asset-scope] sync failed:', scopeError);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function addRoot() {
    const picked = await open({ directory: true, multiple: false, title: '选择扫描根目录' });
    if (typeof picked !== 'string') return; // cancelled
    setBusy(true);
    setError(null);
    setInfo(null);
    try {
      await scanRootCreate(picked);
      setInfo(`已添加扫描根：${baseName(picked)}`);
      await reload();
    } catch (e) {
      // `path` is UNIQUE, so re-adding the same directory rejects.
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggleEnabled(root: ScanRoot) {
    setBusy(true);
    setError(null);
    try {
      await scanRootUpdate(root.id, root.enabled === 1 ? 0 : 1, null);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function changeDepth(root: ScanRoot, raw: string) {
    const depth = Number.parseInt(raw, 10);
    if (!Number.isFinite(depth) || depth < 1) {
      setError('最大深度必须是不小于 1 的整数');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await scanRootUpdate(root.id, null, depth);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeRoot(root: ScanRoot) {
    setBusy(true);
    setError(null);
    try {
      await scanRootDelete(root.id);
      await reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section
      id="settings-scan"
      title="扫描根管理"
      description="扫描器会在这些目录下递归查找游戏。深度越大扫描越慢。"
    >
      <div className="space-y-3">
        {loading ? (
          <SkeletonScanRoots />
        ) : roots.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有扫描根目录。</p>
        ) : (
          <ul className="space-y-2">
            {roots.map((root) => (
              <li
                key={root.id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
              >
                <span
                  className="min-w-0 flex-1 truncate text-sm"
                  title={root.path}
                >
                  {root.path}
                </span>

                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  启用
                  <input
                    type="checkbox"
                    checked={root.enabled === 1}
                    disabled={busy}
                    onChange={() => void toggleEnabled(root)}
                    className="h-4 w-4 accent-[hsl(var(--primary))]"
                  />
                </label>

                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  深度
                  <input
                    type="number"
                    min={1}
                    defaultValue={root.maxDepth}
                    disabled={busy}
                    // Commit on blur/Enter rather than on every keystroke.
                    onBlur={(e) => {
                      if (Number.parseInt(e.target.value, 10) !== root.maxDepth) {
                        void changeDepth(root, e.target.value);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') e.currentTarget.blur();
                    }}
                    className="w-16 rounded border border-input bg-background px-2 py-1 text-xs [.glass_&]:bg-white/5"
                  />
                </label>

                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => void removeRoot(root)}
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-3">
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => scanFolderTip.guard(() => void addRoot())}
          >
            添加扫描根
          </Button>
          {info ? <Status tone="ok">{info}</Status> : null}
        </div>
        {error ? <Status tone="error">{error}</Status> : null}
        {scanFolderTip.dialog}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 2. Appearance
// ---------------------------------------------------------------------------

/**
 * Live state of the glass wallpaper.
 *
 * Seeded from the database (not from the DOM) whenever the user enters the
 * glass theme. Unmounting these controls never clears the saved image or options.
 */
function useBackdropState(): {
  backdrop: BackdropSettings;
  setBackdrop: (next: BackdropSettings) => void;
  /** True once the first read has resolved. */
  loaded: boolean;
} {
  const [backdrop, setBackdrop] = useState<BackdropSettings>(DEFAULT_BACKDROP);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadBackdrop().then((stored) => {
      if (!alive) return;
      setBackdrop(stored);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  return { backdrop, setBackdrop, loaded };
}

/**
 * Watch whether the chosen image can actually be decoded.
 *
 * The wallpaper is a CSS `background-image`, so a renamed or deleted file — or
 * a drive that is no longer mounted — fails silently: there is no element to
 * fire `onerror` on. Loading the same URL into an `Image` is the only way to
 * notice, and it turns "the background just stopped working" into an explicit
 * message next to the picker.
 */
function useBackdropImageError(src: string | undefined): string | null {
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    if (!src) {
      setFailure(null);
      return;
    }
    let alive = true;
    const probe = new Image();
    probe.onload = () => {
      if (alive) setFailure(null);
    };
    probe.onerror = () => {
      if (!alive) return;
      setFailure('找不到这张背景图片，它可能已被移动、删除，或所在的磁盘未连接。');
    };
    probe.src = src;
    return () => {
      alive = false;
      // Release the decode; an in-flight probe is worth dropping when the user
      // immediately picks another file.
      probe.src = '';
    };
  }, [src]);

  return failure;
}

/**
 * 自定义背景 — shown inside 外观, next to the theme buttons.
 *
 * The image itself is painted by CSS on `#lg-backdrop-image` (see
 * `src/index.css` §3b) and it is only visible when the glass theme is active;
 * these controls are mounted only while that theme is selected. Switching to
 * another theme hides the controls and image without clearing saved settings.
 */
function BackdropControls() {
  const { backdrop, setBackdrop, loaded } = useBackdropState();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const imageError = useBackdropImageError(backdropSrc(backdrop.path));

  async function pickImage() {
    const picked = await open({
      multiple: false,
      directory: false,
      title: '选择背景图片',
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }],
    });
    if (typeof picked !== 'string') return; // cancelled

    setError(null);
    setInfo(null);
    // Grant first: painting an ungranted `asset://` URL succeeds in the DOM but
    // never loads, so the order matters for the error message to be truthful.
    try {
      await backdropAssetGrant(picked);
    } catch (e) {
      setError(errorMessage(e));
      return;
    }

    const next: BackdropSettings = { ...backdrop, path: picked };
    setBackdropState(next);
    try {
      await saveBackdrop(next);
      setInfo(`已设置背景图片：${baseName(picked)}`);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  function setBackdropState(next: BackdropSettings) {
    // Apply before persisting so the drag feels instant; the write follows.
    applyBackdrop(next);
    setBackdrop(next);
  }

  async function commit(patch: Partial<BackdropSettings>) {
    // Build the record field by field rather than `{ ...backdrop, ...patch }`:
    // spreading an explicitly-`undefined` property *overwrites* the previous
    // value, so a partial patch would silently reset unrelated fields.
    const next: BackdropSettings = { ...backdrop };
    if (patch.path !== undefined) next.path = patch.path;
    if (patch.opacity !== undefined) next.opacity = patch.opacity;
    if (patch.blur !== undefined) next.blur = patch.blur;
    if (patch.fit !== undefined) next.fit = patch.fit;

    setBackdropState(next);
    setError(null);
    try {
      await saveBackdrop(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function clearImage() {
    const next: BackdropSettings = { ...backdrop, path: '' };
    setBackdropState(next);
    setInfo(null);
    setError(null);
    try {
      await saveBackdrop(next);
      setInfo('已移除背景图片。');
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <div className="mt-5 border-t border-border pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">自定义背景</h3>
        <span className="text-xs text-muted-foreground">
          仅在「液态玻璃」下显示
        </span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        选择一张本地图片作为液态玻璃主题的壁纸。它显示在流动光斑和玻璃面板下方，
        图片只会被读取显示，不会被修改或复制到别处。
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" disabled={!loaded} onClick={() => void pickImage()}>
          {backdrop.path ? '更换图片…' : '选择图片…'}
        </Button>
        <Button
          variant="danger"
          disabled={!loaded || backdrop.path === ''}
          onClick={() => void clearImage()}
        >
          移除
        </Button>
      </div>

      {loaded && backdrop.path ? (
        <p className="mt-2 break-all text-xs text-muted-foreground" title={backdrop.path}>
          当前：{baseName(backdrop.path)}
        </p>
      ) : null}
      {imageError ? (
        <div className="mt-2">
          <Status tone="error">{imageError}</Status>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <span className="flex items-center justify-between">
            <span>图片不透明度</span>
            <span className="tabular-nums text-foreground">{backdrop.opacity}%</span>
          </span>
          <input
            type="range"
            min={BACKDROP_OPACITY_RANGE.min}
            max={BACKDROP_OPACITY_RANGE.max}
            step={BACKDROP_OPACITY_RANGE.step}
            value={backdrop.opacity}
            disabled={!loaded || !backdrop.path}
            onChange={(e) => void commit({ opacity: Number.parseInt(e.target.value, 10) })}
            className="h-4 w-full cursor-pointer accent-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span>仅调节所选壁纸；未选择图片时不影响外观。</span>
        </label>

        <label className="flex flex-col gap-1.5 text-xs text-muted-foreground">
          <span className="flex items-center justify-between">
            <span>背景模糊</span>
            <span className="tabular-nums text-foreground">{backdrop.blur}px</span>
          </span>
          <input
            type="range"
            min={BACKDROP_BLUR_RANGE.min}
            max={BACKDROP_BLUR_RANGE.max}
            step={BACKDROP_BLUR_RANGE.step}
            value={backdrop.blur}
            disabled={!loaded || !backdrop.path}
            onChange={(e) => void commit({ blur: Number.parseInt(e.target.value, 10) })}
            className="h-4 w-full cursor-pointer accent-[hsl(var(--primary))] disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span>仅模糊所选壁纸；调节面板请使用上方「玻璃磨砂强度」。</span>
        </label>
      </div>

      <div className="mt-4">
        <span className="text-xs text-muted-foreground">填充方式</span>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {BACKDROP_FITS.map((fit) => (
            <button
              key={fit}
              type="button"
              disabled={!loaded}
              onClick={() => void commit({ fit })}
              aria-pressed={backdrop.fit === fit}
              title={BACKDROP_FIT_DESCRIPTIONS[fit]}
              className={cn(
                'rounded-md border px-3 py-1.5 text-xs tap disabled:cursor-not-allowed disabled:opacity-50',
                backdrop.fit === fit
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {BACKDROP_FIT_LABELS[fit]}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {BACKDROP_FIT_DESCRIPTIONS[backdrop.fit]}
        </p>
      </div>

      {info ? <div className="mt-3"><Status tone="ok">{info}</Status></div> : null}
      {error ? <div className="mt-3"><Status tone="error">{error}</Status></div> : null}
    </div>
  );
}

function ThemeSection() {
  const [theme, setThemeState] = useState<Theme>(DEFAULT_THEME);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadTheme().then((stored) => {
      if (alive) {
        setThemeState(stored);
        setLoaded(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  async function choose(next: Theme) {
    // Apply first so the UI reacts instantly, then persist.
    setThemeState(next);
    applyTheme(next);
    setError(null);
    try {
      await persistTheme(next);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  return (
    <Section
      id="settings-appearance"
      title="外观"
      description="「跟随系统」会随操作系统的深浅色设置实时切换；「液态玻璃」是带磨砂玻璃与流动光斑背景的深色主题。"
    >
      <div className="flex flex-wrap gap-2">
        {THEMES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => void choose(option)}
            disabled={!loaded}
            aria-pressed={theme === option}
            title={THEME_DESCRIPTIONS[option]}
            className={cn(
              'rounded-md border px-4 py-2 text-sm tap',
              theme === option
                ? 'border-primary bg-primary text-primary-foreground shadow-[inset_0_1px_0_0_hsl(0_0%_100%_/_0.18)]'
                : 'border-border bg-background hover:bg-accent hover:text-accent-foreground',
            )}
          >
            {THEME_LABELS[option]}
          </button>
        ))}
      </div>

      <ThemePreview theme={theme} />

      <p className="mt-3 text-xs text-muted-foreground">
        {THEME_DESCRIPTIONS[theme]}
      </p>

      <AccentSettings />
      {loaded && isGlassTheme(theme) ? <><GlassAppearanceSettings /><BackdropControls /></> : null}

      {error ? (
        <div className="mt-3">
          <Status tone="error">{error}</Status>
        </div>
      ) : null}
    </Section>
  );
}

/**
 * Miniature, non-interactive preview of the selected theme.
 *
 * It is pure markup + the live CSS variables, so it always agrees with the
 * real UI: if the tokens change, this changes. It deliberately re-uses the
 * shared {@link Skeleton} so the shimmer can be inspected without a reload.
 */
function ThemePreview({ theme }: { theme: Theme }) {
  const isGlass = theme === 'glass';
  return (
    <div className="mt-4" aria-hidden>
      <div
        className={cn(
          'glass-preview relative overflow-hidden rounded-lg border border-border p-3',
          isGlass
            ? 'lg-pane-strong [background:linear-gradient(135deg,hsl(268_92%_62%/.85),hsl(196_94%_56%/.7)_45%,hsl(330_92%_62%/.75))]'
            : 'bg-card',
        )}
      >
        <div className="flex items-center gap-3">
          <div
            className={cn(
              'size-10 shrink-0 rounded-md',
              isGlass ? 'bg-white/20 backdrop-blur-md' : 'bg-primary/80',
            )}
          />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton
              variant="shimmer"
              className={cn('h-3 w-1/2', isGlass && 'bg-white/25')}
            />
            <Skeleton
              className={cn('h-2.5 w-5/6', isGlass && 'bg-white/15')}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. Localization
// ---------------------------------------------------------------------------

function LocalizationSection() {
  const { enabled, loaded } = useLocalizationStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void loadLocalizationPreference().catch(cause => setError(errorMessage(cause)));
  }, []);
  async function toggle() {
    setSaving(true);
    setError(null);
    try { await setLocalizationEnabled(!enabled); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }
  return (
    <Section id="settings-localization" title="资料汉化" description="使用内置词典离线汉化标签，适用于已有游戏和新导入资料；简介保留原文。">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p id="localization-label" className="text-sm font-medium">标签离线汉化</p>
          <p className="mt-1 text-xs text-muted-foreground">即时生效，无需联网；关闭后恢复原始标签名称。</p>
        </div>
        <button
          type="button" role="switch" aria-checked={enabled} aria-labelledby="localization-label"
          disabled={!loaded || saving} onClick={() => void toggle()}
          className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', enabled ? 'bg-primary' : 'bg-muted-foreground/40')}
        >
          <span className={cn('inline-block h-4 w-4 rounded-full bg-white transition-transform', enabled ? 'translate-x-6' : 'translate-x-1')} />
        </button>
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        内置 {OFFLINE_TAG_COUNT} 条标签译名，涵盖题材、人物、剧情、结局与系统功能。
        词典未收录的内容保留原文；简介不翻译。汉化只改变显示，不修改标签名称或游戏资料。
      </p>
      {error ? <Status tone="error">{error}</Status> : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 4. Data management
// ---------------------------------------------------------------------------

function DataSection() {
  const [busy, setBusy] = useState<'backup' | 'export' | 'import' | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(
    null,
  );
  const [lastBackup, setLastBackup] = useState<string | null>(null);
  const [format, setFormat] = useState<ExportFormat>('json');

  async function doBackup() {
    const dir = await open({
      directory: true,
      multiple: false,
      title: '选择备份目录',
    });
    if (typeof dir !== 'string') return; // cancelled

    setBusy('backup');
    setMessage(null);
    try {
      const dest = await backupDatabase(dir);
      setLastBackup(dest);
      setMessage({ tone: 'ok', text: `备份完成：${dest}` });
    } catch (e) {
      setMessage({ tone: 'error', text: `备份失败：${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function doExport() {
    const path = await save({
      title: '导出游戏库',
      defaultPath: defaultExportFileName(format),
      filters:
        format === 'json'
          ? [{ name: 'JSON', extensions: ['json'] }]
          : [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (typeof path !== 'string') return; // cancelled

    setBusy('export');
    setMessage(null);
    try {
      const count = await exportGames(format, path);
      setMessage({
        tone: 'ok',
        text: `已导出 ${count} 条记录到 ${baseName(path)}`,
      });
    } catch (e) {
      setMessage({ tone: 'error', text: `导出失败：${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  }

  async function doImport() {
    const path = await open({
      multiple: false,
      directory: false,
      title: '选择要导入的备份文件',
      filters: [{ name: '游戏库导出文件', extensions: ['json', 'csv'] }],
    });
    if (typeof path !== 'string') return; // cancelled

    setBusy('import');
    setMessage(null);
    try {
      const result = await importGames(path);
      setMessage({
        tone: 'ok',
        text: `导入完成：新增 ${result.imported} 条，跳过 ${result.skipped} 条（已存在或缺少标题/路径）。`,
      });
    } catch (e) {
      setMessage({ tone: 'error', text: `导入失败：${errorMessage(e)}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section
      id="settings-data"
      title="数据管理"
      description="完整备份可用于换机与恢复；JSON / CSV 用于交换游戏条目，导入按安装路径去重。"
    >
      <div className="space-y-4">
        <BackupPanel />
        <div>
          <h3 className="mb-2 text-sm font-medium">备份数据库</h3>
          <Button
            variant="primary"
            disabled={busy !== null}
            onClick={() => void doBackup()}
          >
            {busy === 'backup' ? '备份中…' : '选择目录并备份'}
          </Button>
          {lastBackup ? (
            <p className="mt-2 break-all text-xs text-muted-foreground">
              最近备份：{lastBackup}
            </p>
          ) : null}
        </div>

        <div className="border-t border-border pt-4">
          <h3 className="mb-2 text-sm font-medium">导出 / 导入</h3>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
              格式
              <Select<ExportFormat>
                aria-label="导出格式"
                value={format}
                onValueChange={setFormat}
                disabled={busy !== null}
                options={[
                  { value: 'json', label: 'JSON' },
                  { value: 'csv', label: 'CSV' },
                ]}
                className="w-24"
              />
            </span>

            <Button disabled={busy !== null} onClick={() => void doExport()}>
              {busy === 'export' ? '导出中…' : '导出游戏库'}
            </Button>

            <Button disabled={busy !== null} onClick={() => void doImport()}>
              {busy === 'import' ? '导入中…' : '导入游戏库'}
            </Button>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            导入支持 .json 和 .csv（按扩展名判断格式）。CSV 中的逗号、引号与换行会正确处理。
          </p>
        </div>

        {message ? <Status tone={message.tone}>{message.text}</Status> : null}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Window close behaviour
// ---------------------------------------------------------------------------

function WindowSection() {
  const [behavior, setBehavior] = useState<CloseBehavior>('ask');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void settingsGet(CLOSE_BEHAVIOR_KEY)
      .then((value) => {
        if (alive) setBehavior(normalizeCloseBehavior(value));
      })
      .catch((cause) => {
        if (alive) setError(errorMessage(cause));
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function change(next: CloseBehavior) {
    setSaving(true);
    setError(null);
    try {
      await settingsSet(CLOSE_BEHAVIOR_KEY, next);
      setBehavior(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section
      id="settings-window"
      title="窗口"
      description="点击窗口关闭按钮时的行为；「每次询问」会先弹出「缩小至托盘 / 直接关闭」的选择。"
    >
      <div className="max-w-sm space-y-1.5">
        <label htmlFor="close-behavior" className="text-xs font-medium text-muted-foreground">关闭按钮行为</label>
        <Select<CloseBehavior>
          id="close-behavior"
          aria-label="关闭按钮行为"
          value={behavior}
          disabled={!loaded || saving}
          options={[...CLOSE_BEHAVIOR_OPTIONS]}
          onValueChange={(value) => void change(value)}
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        选择「缩小至托盘」后，点击关闭按钮会隐藏窗口，应用继续在系统托盘运行；左键点击托盘图标或选择菜单「显示恋页」可恢复，托盘菜单也能直接退出。
        弹窗里的「今后不再提示」会写入同一个设置。
      </p>
      {error ? <Status tone="error">{error}</Status> : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Metadata title language
// ---------------------------------------------------------------------------

function MetadataSection() {
  const [preference, setPreference] = useState<MetadataTitlePreference>('zh');
  const [defaultSource, setDefaultSource] = useState<MetadataProvider>('vndb');
  const [enabledSources, setEnabledSources] = useState<MetadataProvider[]>([...ALL_PROVIDERS]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void Promise.all([settingsGet(TITLE_LANGUAGE_KEY), settingsGet(DEFAULT_SOURCE_KEY)])
      .then(([value, source]) => {
        if (alive) {
          setPreference(normalizeTitlePreference(value));
          setDefaultSource(normalizeDefaultSource(source));
        }
      })
      .catch((cause) => {
        if (alive) setError(errorMessage(cause));
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function change(next: MetadataTitlePreference) {
    setSaving(true);
    setError(null);
    try {
      await settingsSet(TITLE_LANGUAGE_KEY, next);
      setPreference(next);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function changeSource(next: MetadataProvider) {
    setSaving(true);
    setError(null);
    try {
      await settingsSet(DEFAULT_SOURCE_KEY, next);
      setDefaultSource(next);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }

  return (
    <Section
      id="settings-metadata"
      title="资料匹配"
      description="设置导入和联网补全时优先采用的数据源，以及游戏标题的语言。"
    >
      <div className="mb-4 max-w-sm space-y-1.5">
        <SearchSourcesSettings onChange={setEnabledSources} />
        <label htmlFor="metadata-default-source" className="text-xs font-medium text-muted-foreground">默认数据源</label>
        <Select<MetadataProvider>
          id="metadata-default-source"
          aria-label="默认数据源"
          value={normalizeDefaultSource(defaultSource, enabledSources)}
          disabled={!loaded || saving || !enabledSources.length}
          options={enabledSources.map(value => ({ value, label: PROVIDER_LABELS[value] }))}
          onValueChange={value => void changeSource(value)}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          导入优先采用默认源的可信匹配，没有合适结果或请求失败时使用其他已启用来源。默认源被关闭后，会自动使用已启用列表中的首个来源；手动搜索也只使用上方勾选的范围。更改后即时保存。
        </p>
      </div>
      <div className="max-w-sm space-y-1.5">
        <label htmlFor="metadata-title-language" className="text-xs font-medium text-muted-foreground">标题语言</label>
        <Select<MetadataTitlePreference>
          id="metadata-title-language"
          aria-label="标题语言"
          value={preference}
          disabled={!loaded || saving}
          options={[
            { value: 'zh', label: '中文名优先（推荐）' },
            { value: 'ja', label: '日文原名优先' },
            { value: 'source', label: '数据源标题（可能是英文）' },
          ]}
          onValueChange={(value) => void change(value)}
        />
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        中文名优先：中文标题 → 日文原名 → 数据源标题；日文原名优先：日文原名 → 中文标题 → 数据源标题。
        搜索名称仅用于查找作品，不会盖过资料中的中文标题；已有游戏可重新匹配资料并应用游戏名。
      </p>
      {error ? <Status tone="error">{error}</Status> : null}
      <MetadataRefreshPanel />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// 公开游戏库 — custom-cover verification (design item 3)
// ---------------------------------------------------------------------------

/** Cloud cover review is disabled; custom-cover works remain private. */
function PublicLibrarySection() {
  const [covers, setCovers] = useState<CoverStatus[] | null>(null);
  const [coverPaths, setCoverPaths] = useState<Record<number, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true); setError(null);
    void Promise.all([friendsCoverStatus(), settingsGetAll()])
      .then(([list, settings]) => {
        if (!alive) return;
        setCovers(list);
        const paths: Record<number, string | null> = {};
        for (const setting of settings) {
          if (!setting.key.startsWith(COVER_SETTING_PREFIX)) continue;
          const gameId = Number(setting.key.slice(COVER_SETTING_PREFIX.length));
          if (Number.isInteger(gameId)) paths[gameId] = parseCoverPreferences(setting.value).customPath;
        }
        setCoverPaths(paths);
      })
      .catch(cause => { if (alive) setError(errorMessage(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [attempt]);
  const custom = (covers ?? []).filter(cover => cover.customCover);
  const labels: Record<CoverStatus['reviewStatus'], string> = {
    disabled: '云端封面审核未启用，该作品暂不公开',
    offline: '暂未取得公开状态，该作品暂不公开',
    unavailable: '暂时无法读取公开状态，该作品暂不公开',
    notSubmitted: '未提交封面，该作品暂不公开',
    pending: '封面待审核，该作品暂不公开',
    approved: '当前版本未启用云端封面审核，该作品暂不公开',
    rejected: '封面未通过审核，该作品暂不公开',
  };
  return <Section id="settings-public-library" title="公开游戏库" description="当前版本未启用云端封面审核。使用自定义封面的作品暂不展示给好友。">
    <p className="text-sm leading-relaxed text-muted-foreground">来源封面可随公开游戏库分享；NSFW 或分级未知的来源封面会自动打码。使用自定义封面的作品暂不公开，恢复来源封面后可按分享设置同步。</p>
    <div className="mt-3"><Button disabled={loading} onClick={() => setAttempt(value => value + 1)}>{loading ? '正在读取封面状态…' : '刷新封面状态'}</Button></div>
    {error ? <Status tone="error">无法读取封面状态：{error}</Status> : null}
    {!loading && !error && custom.length === 0 ? <Status tone="info">没有使用自定义封面的作品。</Status> : null}
    {custom.length > 0 ? <ul className="mt-3 max-h-96 space-y-2 overflow-y-auto">
      {custom.map(cover => <li key={cover.gameId} className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">
        <div className="h-16 w-12 shrink-0 overflow-hidden rounded bg-muted"><CoverImage gameId={cover.gameId} path={coverPaths[cover.gameId] ?? null} alt={cover.title} className="h-full w-full object-cover" fallbackText="" /></div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{cover.title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{labels[cover.reviewStatus]}</p>
          {cover.nsfw ? <p className="mt-1 text-xs text-muted-foreground">NSFW 或分级未知；恢复来源封面并公开时会自动打码。</p> : null}
        </div>
        <Link to={`/library/${cover.gameId}`} className="text-xs text-primary hover:underline">查看作品</Link>
      </li>)}
    </ul> : null}
    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">本机封面偏好无法授予公开权限。私人游戏库仍可正常使用自定义封面、打码和裁剪设置。</p>
  </Section>;
}

// ---------------------------------------------------------------------------
// 账号注销 — irreversible account deletion (design item 15)
// ---------------------------------------------------------------------------

/**
 * Two-step destructive flow: type the account's own `@username`, then confirm
 * in a destructive ConfirmDialog. On success the cached frontend identity is
 * dropped (`useFriendsStore.invalidate()`); a failed call surfaces the backend
 * error and never claims success.
 */
function AccountDeletionSection() {
  const [account, setAccount] = useState<Account | null>(null);
  const [deletionPending, setDeletionPending] = useState(false);
  const [resumePassword, setResumePassword] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [typed, setTyped] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setLoadError(null);
    void friendsStatus()
      .then(status => { if (alive) { setAccount(status.account); setDeletionPending(status.deletionPending === true); } })
      .catch(cause => { if (alive) setLoadError(errorMessage(cause)); })
      .finally(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, [reload]);

  const required = account ? `@${account.username}` : '';
  const matches = account !== null && typed.trim() === required;

  async function removeAccount(reauthenticate = false) {
    if ((!account && !deletionPending) || busy) return;
    setBusy(true);
    setDeleteError(null);
    setSuccess(null);
    try {
      if (reauthenticate && account) await friendsResumeDeletion(resumePassword, account.id);
      else await friendsDeleteAccount(account?.id);
      useFriendsStore.getState().invalidate();
      setAccount(null);
      setDeletionPending(false);
      setTyped('');
      setConfirming(false);
      setSuccess('账号已注销，本机登录状态已清除。本机游戏库、存档与资料未受影响。');
    } catch (cause) {
      setConfirming(false);
      setDeleteError(`注销失败：${errorMessage(cause)}`);
      try { setDeletionPending((await friendsStatus()).deletionPending === true); } catch { /* Keep the existing pending state. */ }
    } finally {
      setResumePassword('');
      setBusy(false);
    }
  }

  return (
    <Section
      id="settings-account"
      title="账号注销"
      description="永久删除好友账号及其服务器数据，此操作不可恢复。"
    >
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
        <p className="text-sm font-medium text-destructive">危险操作</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          注销会立即删除你的账号，以及好友关系、待处理请求、公开游戏库同步数据和最近游玩记录同步数据。服务器数据删除后无法恢复，也无法用同一账号重新登录找回。本机游戏库、存档和资料不会被删除。
        </p>
      </div>
      {!loaded ? <Status tone="info">正在读取账号状态…</Status> : null}
      {loadError ? <div className="mt-3 space-y-2">
        <Status tone="error">无法读取账号状态：{loadError}</Status>
        <Button onClick={() => setReload(value => value + 1)}>重新读取</Button>
      </div> : null}
      {loaded && !loadError && !account && !success && !deletionPending ? <Status tone="info">当前未登录好友账号。请先在「好友」页登录，再回来注销。</Status> : null}
      {deletionPending ? <div className="mt-3 space-y-2">
        <Status tone="info">上次注销结果尚待确认，好友同步已暂停，登录凭据已保留。请重试确认；只有服务器确认认证账号已删除后才会显示完成。</Status>
        <Button disabled={busy} onClick={() => void removeAccount()}>{busy ? '正在确认…' : '重试并确认注销结果'}</Button>
        {account ? <details className="rounded-md border border-border p-3"><summary className="cursor-pointer text-sm">原登录会话已失效？验证原账号后继续注销</summary>
          <p className="mt-2 text-xs text-muted-foreground">仅验证 @{account.username}，不会切换注销对象。</p>
          <input type="password" autoComplete="current-password" aria-label="原注销账号的密码" value={resumePassword} disabled={busy} onChange={event => setResumePassword(event.target.value)} className="mt-2 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"/>
          <div className="mt-2"><Button disabled={busy || resumePassword.length < 12} onClick={() => void removeAccount(true)}>验证原账号并继续注销</Button></div>
        </details> : null}
      </div> : null}
      {account && !deletionPending ? <div className="mt-3 space-y-2">
        <p className="text-sm">当前账号：<span className="font-medium">{required}</span>{account.nickname && account.nickname !== account.username ? `（${account.nickname}）` : ''}</p>
        <label className="block text-sm" htmlFor="account-delete-confirm">
          <span className="text-xs text-muted-foreground">输入 <span className="select-text font-medium text-foreground">{required}</span> 以确认注销</span>
          <input
            id="account-delete-confirm"
            value={typed}
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            placeholder={required}
            onChange={event => setTyped(event.target.value)}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
        </label>
        <Button variant="danger" disabled={!matches || busy} onClick={() => setConfirming(true)}>注销账号</Button>
      </div> : null}
      {deleteError ? <Status tone="error">{deleteError}</Status> : null}
      {success ? <Status tone="ok">{success}</Status> : null}
      <ConfirmDialog
        open={confirming}
        title="确认注销账号？"
        confirmText="永久注销账号"
        destructive
        busy={busy}
        description={<div className="space-y-2 text-sm">
          <p>将删除账号 <span className="select-text font-medium">{required}</span>，以及好友关系、公开游戏库和游玩记录同步数据。</p>
          <p>此操作不可恢复，也无法找回。本机游戏库、存档与资料不受影响。</p>
        </div>}
        onCancel={() => { if (!busy) setConfirming(false); }}
        onConfirm={() => void removeAccount()}
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function SettingsPage() {
  return (
    <div className="mx-auto flex max-w-5xl items-start gap-6 p-6">
      {/* The anchor nav lives in the empty gutter beside the content and stays
          pinned while the sections scroll — the same place a desktop sidebar
          would occupy, without taking width away from the cards. */}
      <aside className="sticky top-6 z-10 w-36 shrink-0 self-start">
        <SettingsSectionNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <header>
          <h1 className="text-xl font-semibold">设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            扫描目录、外观、窗口、资料汉化、资料匹配与数据备份。
          </p>
        </header>

        <ScanRootsSection />
        <ThemeSection />
        <WindowSection />
        <LocalizationSection />
        <MetadataSection />
        <Section id="settings-bangumi-sync" title="Bangumi 双向同步" description="连接个人账号，同步游玩状态与个人记录。"><BangumiSyncSettings /></Section>

        <Section id="settings-birthdays" title="角色生日" description="在特别的日子，为喜欢的角色送上祝福。">
          <BirthdayReminderSettings />
        </Section>
        <DataSection />
        <PublicLibrarySection />
        <Section id="settings-paths" title="游戏路径" description="检查离线或缺失的游戏，并在搬盘后批量修复路径。">
          <PathRepairPanel />
        </Section>
        <Section id="settings-logs" title="日志" description="保存故障排查信息，并导出用于反馈问题的诊断日志。">
          <LogSettings />
        </Section>
        <Section id="settings-announcements" title="公告" description="随时重新查看应用公告和当前版本的更新内容。">
          <AnnouncementSettings />
        </Section>
        <AccountDeletionSection />
        <Section id="settings-about" title="关于恋页">
          <div className="flex items-center gap-4">
            <img src={BRAND.icon} alt="恋页应用图标" width={64} height={64} className="h-16 w-16 shrink-0" />
            <div className="min-w-0">
              <p className="text-lg font-semibold">{BRAND.name} <span className="text-sm font-normal text-muted-foreground">{BRAND.latinName}</span></p>
              <p className="mt-1 text-sm text-muted-foreground">{BRAND.tagline}</p>
              <p className="mt-1 text-xs text-muted-foreground">Galgame / 视觉小说收藏馆 · v{BRAND.version}</p>
              <p className="mt-2 text-xs text-muted-foreground">GitHub：<GithubProfileLink display="url" className="break-all" /></p>
            </div>
          </div>
          <UpdateSettings />
          <div className="mt-4 space-y-2"><p className="text-sm font-medium">协议与隐私</p><LegalDocuments/></div>
          <p className="mt-4 text-xs text-muted-foreground">开源协议：GNU GPL v3（GPL-3.0-only）。第三方工具、角色与资料遵循各自的许可声明。</p>
          <AnnouncementContact />
        </Section>
      </div>
    </div>
  );
}
