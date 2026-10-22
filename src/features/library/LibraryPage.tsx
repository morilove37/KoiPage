import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { loadInstallationState, useInstallationStore } from "@/features/installation/store";
import { matchesInstallation } from "@/features/installation/model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LabeledSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useLocalizedTags } from "@/lib/localization";
import {
  gamesDelete,
  gamesList,
  gamesStats,
  gamesTagsGet,
  tagsList,
  gameUpdate,
} from "@/lib/db";
import { useAppStore } from "@/store/app";
import type { SortDirection, SortKey } from "@/store/app";
import {
  GAME_STATUSES,
  GAME_STATUS_LABELS,
  formatPlayTime,
  isFavorite,
} from "@/types/game";
import type { Game, GameInput, GameStats, Tag } from "@/types/game";

import { gamesBatchUpdate } from "./api";
import type { LibraryBatchPatch } from "./api";
import { visibleSelection } from "./preferences";
import type { LibraryFilters } from "./preferences";
import type { GameStatus } from "@/types/game";

import { GameCard } from "./GameCard";
import { GameRow } from "./GameRow";
import ScanDialog from "@/features/scan/ScanDialog";
import BatchImportDialog from "@/features/scan/BatchImportDialog";
import type { PendingImport } from "@/features/scan/BatchImportDialog";
import { takePendingScanRoots } from "@/features/scan/pendingScan";
import MetadataDialog from "@/features/metadata/MetadataDialog";

let libraryScrollTop = 0;

const SORT_OPTIONS: ReadonlyArray<{ value: SortKey; label: string }> = [
  { value: "title", label: "标题" },
  { value: "createdAt", label: "最近添加" },
  { value: "releaseDate", label: "发售日" },
  { value: "rating", label: "评分" },
  { value: "lastPlayedAt", label: "最近游玩" },
  { value: "playTime", label: "游玩时长" },
];

const STATUS_OPTIONS = [
  { value: "", label: "全部状态" },
  ...GAME_STATUSES.map((status) => ({
    value: status,
    label: GAME_STATUS_LABELS[status],
  })),
];

const ShareDialog = lazy(() => import("@/features/share/ShareDialog"));

/**
 * Compare two nullable strings/numbers for sorting.
 *
 * Empty values (`null` / `''`) always sink to the bottom regardless of
 * direction: an unrated game should not outrank a rated one just because the
 * user flipped the arrow.
 */
function compareNullable<T>(
  a: T | null | undefined,
  b: T | null | undefined,
  direction: SortDirection,
): number {
  const aEmpty = a === null || a === undefined || a === "";
  const bEmpty = b === null || b === undefined || b === "";
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const order = a < b ? -1 : a > b ? 1 : 0;
  return direction === "asc" ? order : -order;
}

export default function LibraryPage() {
  const { viewMode, sortKey, sortDirection, filters, presets } = useAppStore((s) => s.library);
  const setViewMode = useAppStore((s) => s.setViewMode);
  const setSort = useAppStore((s) => s.setSort);
  const playTimeRevision = useAppStore((s) => s.playTimeRevision);

  const [games, setGames] = useState<Game[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [links, setLinks] = useState<Array<[number, number]>>([]);
  const [stats, setStats] = useState<GameStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const setLibraryFilters = useAppStore(s => s.setLibraryFilters);
  const saveLibraryPreset = useAppStore(s => s.saveLibraryPreset);
  const deleteLibraryPreset = useAppStore(s => s.deleteLibraryPreset);
  const { search, status, favoriteOnly, activeTagIds, developer, installation } = filters;
  const archived = useInstallationStore(state => state.archived);
  const setFilter = <K extends keyof LibraryFilters>(key: K, value: LibraryFilters[K] | ((current: LibraryFilters[K]) => LibraryFilters[K])) => {
    const current = useAppStore.getState().library.filters;
    setLibraryFilters({ ...current, [key]: typeof value === "function" ? value(current[key]) : value });
  };
  const setSearch = (value: string) => setFilter("search", value);
  const setStatus = (value: string) => setFilter("status", value);
  const setFavoriteOnly = (value: boolean | ((current: boolean) => boolean)) => setFilter("favoriteOnly", value);
  const setDeveloper = (value: string) => setFilter("developer", value);
  const setActiveTagIds = useCallback((value: number[] | ((current: number[]) => number[])) => {
    const current = useAppStore.getState().library.filters;
    setLibraryFilters({ ...current, activeTagIds: typeof value === "function" ? value(current.activeTagIds) : value });
  }, [setLibraryFilters]);
  const [presetName, setPresetName] = useState("");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchStatus, setBatchStatus] = useState("");
  const [batchTag, setBatchTag] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const restoredScroll = useRef(false);
  useEffect(() => {
    const main = rootRef.current?.closest("main");
    if (!main) return;
    const remember = () => { libraryScrollTop = main.scrollTop; };
    main.addEventListener("scroll", remember);
    return () => { main.removeEventListener("scroll", remember); };
  }, []);
  useEffect(() => {
    if (loading || restoredScroll.current) return;
    const saved = libraryScrollTop;
    const frame = requestAnimationFrame(() => {
      const main = rootRef.current?.closest("main");
      if (main) main.scrollTop = saved;
      restoredScroll.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [loading]);
  const [scanOpen, setScanOpen] = useState(false);
  // Folders extracted in 实用工具 are handed over through sessionStorage; the
  // scan dialog opens preloaded so the user lands on the review list.
  const [pendingScanRoots, setPendingScanRoots] = useState<string[] | null>(null);
  useEffect(() => {
    const roots = takePendingScanRoots();
    if (roots !== null) {
      setPendingScanRoots(roots);
      setScanOpen(true);
    }
  }, []);
  const [metadataQueue, setMetadataQueue] = useState<GameInput[]>([]);
  const [batchDrafts, setBatchDrafts] = useState<GameInput[] | null>(null);
  const [customImportPaths, setCustomImportPaths] = useState<Set<string>>(() => new Set());
  const [importTotal, setImportTotal] = useState(0);
  const [importNotice, setImportNotice] = useState<string | null>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  /**
   * Multi-select for bulk deletion.
   *
   * Entries are pruned against what is currently visible (see the effect
   * below). That matters because this selection feeds a **destructive** action:
   * if a hidden-but-still-selected row survived a filter change, the delete
   * confirmation would end up removing games the user could not see, and no
   * amount of warning text makes that acceptable.
   */
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextGames, nextTags, nextLinks, nextStats] = await Promise.all([
        gamesList(),
        tagsList(),
        gamesTagsGet(),
        gamesStats(),
        loadInstallationState(),
      ]);
      setGames(nextGames);
      setTags(nextTags);
      setLinks(nextLinks);
      setStats(nextStats);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, playTimeRevision]);

  /** gameId -> tagIds, built once per link change instead of per card. */
  const tagsByGame = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const [gameId, tagId] of links) {
      const list = map.get(gameId);
      if (list) list.push(tagId);
      else map.set(gameId, [tagId]);
    }
    return map;
  }, [links]);

  // The library filter only shows tags that are attached to at least one
  // imported game. Orphan tags remain manageable on the dedicated tags page.
  const usedTags = useMemo(() => {
    const used = new Set(links.map(([, tagId]) => tagId));
    return tags.filter((tag) => used.has(tag.id));
  }, [tags, links]);

  const { t } = useLocalizedTags();
  const tagById = useMemo(() => {
    const map = new Map<number, Tag>();
    for (const tag of tags) map.set(tag.id, { ...tag, name: t(tag.name) });
    return map;
  }, [tags, t]);

  const metadataGame = metadataQueue[0] ?? null;

  const handleConfirmed = useCallback((drafts: GameInput[], mode: "manual" | "automatic") => {
    if (mode === "automatic") setBatchDrafts(drafts);
    else setMetadataQueue(drafts);
    setCustomImportPaths(new Set());
    setImportTotal(drafts.length);
    setImportNotice(null);
  }, []);

  const handleBatchFinished = useCallback(() => { void reload(); }, [reload]);
  const handleBatchManual = useCallback((remaining: PendingImport[]) => {
    setBatchDrafts(null);
    setMetadataQueue(remaining.map(item => item.draft));
    setCustomImportPaths(new Set(remaining.filter(item => item.manual).map(item => item.draft.installPath)));
    setImportTotal(remaining.length);
  }, []);

  const finishMetadataStep = useCallback(() => {
    setMetadataQueue((current) => current.slice(1));
  }, []);

  const handleCreated = useCallback((created: Game) => {
    setImportNotice(`已导入「${created.title}」。`);
    finishMetadataStep();
    void reload();
  }, [finishMetadataStep, reload]);

  useEffect(() => {
    if (loading) return;
    const ids = new Set(usedTags.map((tag) => tag.id));
    setActiveTagIds((current) => {
      const next = current.filter((id) => ids.has(id));
      return next.length === current.length ? current : next;
    });
  }, [usedTags, loading, setActiveTagIds]);

  const developers = useMemo(() => {
    const set = new Set<string>();
    for (const game of games) {
      if (game.developer) set.add(game.developer);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
  }, [games]);

  const visibleGames = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = games.filter((game) => {
      if (!matchesInstallation(installation, Boolean(archived[game.id]))) return false;
      if (needle) {
        const haystack = [game.title, game.originalTitle, game.developer]
          .filter((value): value is string => Boolean(value))
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (status && game.status !== status) return false;
      if (favoriteOnly && !isFavorite(game)) return false;
      if (developer && game.developer !== developer) return false;
      if (activeTagIds.length > 0) {
        const gameTags = tagsByGame.get(game.id) ?? [];
        // AND semantics: a game must carry every selected tag.
        if (!activeTagIds.every((tagId) => gameTags.includes(tagId))) return false;
      }
      return true;
    });

    return filtered.sort((a, b) => {
      switch (sortKey) {
        case "title":
          return (
            compareNullable(a.title, b.title, sortDirection) ||
            compareNullable(a.id, b.id, "asc")
          );
        case "createdAt":
          return compareNullable(a.createdAt, b.createdAt, sortDirection) || compareNullable(a.id, b.id, sortDirection);
        case "releaseDate":
          return compareNullable(a.releaseDate, b.releaseDate, sortDirection);
        case "rating":
          return compareNullable(a.rating, b.rating, sortDirection);
        case "lastPlayedAt":
          return compareNullable(a.lastPlayedAt, b.lastPlayedAt, sortDirection);
        case "playTime":
          return compareNullable(
            a.playTimeSeconds,
            b.playTimeSeconds,
            sortDirection,
          );
        default:
          return 0;
      }
    });
  }, [
    archived,
    installation,
    games,
    search,
    status,
    favoriteOnly,
    developer,
    activeTagIds,
    tagsByGame,
    sortKey,
    sortDirection,
  ]);

  // ---------------------------------------------------------------------
  // Multi-select
  // ---------------------------------------------------------------------

  /** Drop selected ids that are no longer visible. */
  useEffect(() => {
    setSelectedIds((current) => {
      if (current.size === 0) return current;
      const visible = new Set(visibleGames.map((game) => game.id));
      const next = new Set<number>();
      for (const id of current) if (visible.has(id)) next.add(id);
      // Only replace when something actually changed, so this cannot loop.
      return next.size === current.size ? current : next;
    });
  }, [visibleGames]);

  const toggleSelected = useCallback((gameId: number) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(gameId)) next.delete(gameId);
      else next.add(gameId);
      return next;
    });
  }, []);

  /** Select every game currently passing the filters. */
  const selectAllVisible = useCallback(() => {
    setSelectedIds(new Set(visibleGames.map((game) => game.id)));
  }, [visibleGames]);

  /** Swap: everything visible that was not selected becomes selected. */
  const invertSelection = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set<number>();
      for (const game of visibleGames) if (!current.has(game.id)) next.add(game.id);
      return next;
    });
  }, [visibleGames]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const exitSelectMode = useCallback(() => {
    setSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const allVisibleSelected =
    visibleGames.length > 0 && selectedIds.size === visibleGames.length;

  /** Games backing the current selection, in display order (for the confirm). */
  const selectedGames = useMemo(
    () => visibleGames.filter((game) => selectedIds.has(game.id)),
    [visibleGames, selectedIds],
  );

  const bulkDelete = useCallback(async () => {
    const ids = visibleSelection(selectedIds, visibleGames);
    if (ids.length === 0) return;
    setDeleting(true);
    setError(null);
    try {
      const result = await gamesDelete(ids);
      setConfirmBulkDelete(false);
      setSelectedIds(new Set());
      // Leaving select mode after a delete avoids a stale "已选 0 部" toolbar.
      setSelectMode(false);
      await reload();
      if (result.missing.length > 0) {
        setError(
          `已删除 ${result.deleted} 部；另有 ${result.missing.length} 部已不存在（可能被其他窗口删除）。`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setConfirmBulkDelete(false);
    } finally {
      setDeleting(false);
    }
  }, [selectedIds, visibleGames, reload]);

  const applyBatch = async (patch: LibraryBatchPatch) => {
    const ids = visibleSelection(selectedIds, visibleGames);
    if (!ids.length || batchBusy) return;
    setBatchBusy(true);
    setError(null);
    try {
      const count = await gamesBatchUpdate(ids, patch);
      setSelectedIds(new Set());
      await reload();
      setImportNotice(`已更新 ${count} 部游戏。`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBatchBusy(false); }
  };

  const toggleTag = (tagId: number) => {
    setActiveTagIds((current) =>
      current.includes(tagId)
        ? current.filter((id) => id !== tagId)
        : [...current, tagId],
    );
  };

  const resetFilters = () => {
    setFilter("installation", "all");
    setSearch("");
    setStatus("");
    setFavoriteOnly(false);
    setDeveloper("");
    setActiveTagIds([]);
  };

  const toggleFavorite = async (game: Game) => {
    const next = isFavorite(game) ? 0 : 1;
    // Optimistic: the grid should react instantly on a favourite click.
    setGames((current) =>
      current.map((item) => (item.id === game.id ? { ...item, favorite: next } : item)),
    );
    try {
      await gameUpdate(game.id, { favorite: next });
      setStats(await gamesStats());
    } catch (cause) {
      setGames((current) =>
        current.map((item) =>
          item.id === game.id ? { ...item, favorite: game.favorite } : item,
        ),
      );
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const hasFilters =
    installation !== "all" ||
    search.trim() !== "" ||
    status !== "" ||
    favoriteOnly ||
    developer !== "" ||
    activeTagIds.length > 0;

  return (
    <div ref={rootRef} className="flex flex-col gap-3 px-4 py-3" data-library-state={loading ? "loading" : error ? "error" : "ready"}>
      {/* Header ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">游戏库</h1>
          <p className="text-xs text-muted-foreground">
            {loading
              ? "载入中…"
              : `共 ${stats?.total ?? games.length} 部 · 显示 ${visibleGames.length} 部` +
                (stats && stats.playTimeSeconds > 0
                  ? ` · 累计 ${formatPlayTime(stats.playTimeSeconds)}`
                  : "")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-md bg-muted p-1">
            {(["grid", "list"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => setViewMode(mode)}
                aria-pressed={viewMode === mode}
                className={cn(
                  "rounded px-3 py-1 text-xs font-medium transition-colors",
                  viewMode === mode
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {mode === "grid" ? "网格" : "列表"}
              </button>
            ))}
          </div>
          <Button onClick={() => setScanOpen(true)}>添加游戏</Button>
          <Button variant="outline" disabled={loading} onClick={() => setShareOpen(true)}>分享足迹</Button>
          {selectMode ? (
            <Button variant="outline" onClick={exitSelectMode}>
              退出多选
            </Button>
          ) : (
            <Button
              variant="outline"
              onClick={() => setSelectMode(true)}
              disabled={visibleGames.length === 0}
              title={
                visibleGames.length === 0
                  ? "当前没有可选的游戏"
                  : "进入多选，可批量管理"
              }
            >
              多选
            </Button>
          )}
          <Button variant="outline" onClick={() => void reload()} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      {/*
        Selection bar. Only rendered in select mode, directly under the header so
        it is impossible to miss what is about to be deleted.
      */}
      {selectMode ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-sm font-medium">
            已选 {selectedIds.size} 部
          </span>
          <span className="text-xs text-muted-foreground">
            （当前显示 {visibleGames.length} 部）
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2" aria-busy={batchBusy}>
            <LabeledSelect label="批量状态" className="w-28" value={batchStatus} onValueChange={setBatchStatus} options={[{value:"",label:"选择状态"}, ...STATUS_OPTIONS.slice(1)]} />
            <Button variant="outline" disabled={!selectedGames.length || !batchStatus || batchBusy} onClick={() => void applyBatch({ status: batchStatus as GameStatus })}>设定状态</Button>
            <Button variant="outline" disabled={!selectedGames.length || batchBusy} onClick={() => void applyBatch({ favorite: true })}>收藏</Button>
            <Button variant="outline" disabled={!selectedGames.length || batchBusy} onClick={() => void applyBatch({ favorite: false })}>取消收藏</Button>
            <LabeledSelect label="批量标签" className="w-28" value={batchTag} onValueChange={setBatchTag} options={[{value:"",label:"选择标签"}, ...tags.map(tag => ({value:String(tag.id),label:t(tag.name)}))]} />
            <Button variant="outline" disabled={!selectedGames.length || !batchTag || batchBusy} onClick={() => void applyBatch({ addTagIds: [Number(batchTag)] })}>添加标签</Button>
            <Button variant="outline" disabled={!selectedGames.length || !batchTag || batchBusy} onClick={() => void applyBatch({ removeTagIds: [Number(batchTag)] })}>移除标签</Button>
            <Button
              variant="outline"
              onClick={selectAllVisible}
              disabled={visibleGames.length === 0 || allVisibleSelected}
            >
              {allVisibleSelected ? "已全选" : "全选"}
            </Button>
            <Button
              variant="outline"
              onClick={invertSelection}
              disabled={visibleGames.length === 0}
            >
              反选
            </Button>
            <Button
              variant="outline"
              onClick={clearSelection}
              disabled={selectedIds.size === 0 || batchBusy}
            >
              清除选择
            </Button>
            <Button
              variant="destructive"
              onClick={() => setConfirmBulkDelete(true)}
              disabled={selectedIds.size === 0 || batchBusy}
            >
              删除选中{selectedIds.size > 0 ? `（${selectedIds.size}）` : ""}
            </Button>
          </div>
        </div>
      ) : null}

      {/* Stats strip ----------------------------------------------------- */}
      {stats && stats.total > 0 ? (
        <div className="flex flex-wrap gap-2">
          <Badge variant="secondary">收藏 {stats.favorite}</Badge>
          {stats.byStatus
            .filter(([, count]) => count > 0)
            .map(([key, count]) => (
              <Badge key={key} variant="outline">
                {GAME_STATUS_LABELS[key]} {count}
              </Badge>
            ))}
        </div>
      ) : null}

      {/* Filters --------------------------------------------------------- */}
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex min-w-48 flex-1 flex-col gap-1">
            <span className="text-xs font-medium text-muted-foreground">
              搜索
            </span>
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="标题 / 原名 / 开发商"
            />
          </div>

          <LabeledSelect label="安装状态" className="w-36 gap-1" value={installation} onValueChange={value => setFilter("installation", value as LibraryFilters["installation"])} options={[{value:"all",label:"全部安装状态"},{value:"installed",label:"已安装"},{value:"archived",label:"已卸载 / 已归档"}]} />

          <LabeledSelect
            label="状态"
            className="w-32 gap-1"
            value={status}
            onValueChange={setStatus}
            options={STATUS_OPTIONS}
          />

          <LabeledSelect
            label="开发商"
            className="w-40 gap-1"
            value={developer}
            onValueChange={setDeveloper}
            options={[
              { value: "", label: "全部开发商" },
              ...developers.map((name) => ({ value: name, label: name })),
            ]}
          />

          <LabeledSelect
            label="排序"
            className="w-32 gap-1"
            value={sortKey}
            onValueChange={(next) => setSort(next)}
            options={SORT_OPTIONS.map((option) => ({
              value: option.value,
              label: option.label,
            }))}
          />

          <Button
            variant="outline"
            onClick={() =>
              setSort(sortKey, sortDirection === "asc" ? "desc" : "asc")
            }
            title="切换升降序"
          >
            {sortDirection === "asc" ? "升序 ↑" : "降序 ↓"}
          </Button>

          <Button
            variant={favoriteOnly ? "default" : "outline"}
            onClick={() => setFavoriteOnly((current) => !current)}
            aria-pressed={favoriteOnly}
          >
            ★ 仅收藏
          </Button>

          {hasFilters ? (
            <Button variant="ghost" onClick={resetFilters}>
              清除筛选
            </Button>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Input className="w-36" aria-label="筛选名称" placeholder="常用筛选名称" maxLength={40} value={presetName} onChange={event => setPresetName(event.target.value)} />
          <Button variant="outline" disabled={!presetName.trim()} onClick={() => { saveLibraryPreset(presetName); setPresetName(""); }}>保存筛选</Button>
          {presets.map(preset => <span key={preset.name} className="inline-flex items-center gap-1 rounded border border-border px-2 py-1 text-xs">
            <button type="button" className="hover:text-primary" onClick={() => setLibraryFilters(preset.filters)}>{preset.name}</button>
            <button type="button" className="text-muted-foreground hover:text-destructive" aria-label={`删除筛选 ${preset.name}`} onClick={() => deleteLibraryPreset(preset.name)}>×</button>
          </span>)}
        </div>

        {usedTags.length > 0 ? (
          <div className="flex items-start gap-1.5">
            <span className="mr-1 shrink-0 py-1 text-xs font-medium text-muted-foreground">
              标签
            </span>
            <div
              className={cn(
                "flex min-w-0 flex-1 gap-1.5",
                tagsExpanded ? "flex-wrap" : "max-h-7 flex-nowrap overflow-hidden",
              )}
            >
            {usedTags.map((tag) => {
              const active = activeTagIds.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  onClick={() => toggleTag(tag.id)}
                  title={tag.name}
                  aria-pressed={active}
                  className={cn(
                    "shrink-0 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs transition-colors",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                >
                  {t(tag.name)}
                </button>
              );
            })}
            </div>
            <button
              type="button"
              className="shrink-0 py-1 text-xs text-primary hover:underline"
              onClick={() => setTagsExpanded((value) => !value)}
              aria-expanded={tagsExpanded}
            >
              {tagsExpanded ? "收起" : "展开"}
            </button>
            {activeTagIds.length > 0 ? (
              <span className="shrink-0 py-1 text-xs text-muted-foreground">
                已选 {activeTagIds.length}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          操作失败：{error}
        </div>
      ) : null}
      {importNotice ? (
        <div role="status" className="rounded-md border border-border bg-accent px-3 py-2 text-sm">
          {importNotice}
        </div>
      ) : null}

      {/* Results --------------------------------------------------------- */}
      {!loading && games.length === 0 ? (
        <EmptyState
          title="游戏库还是空的"
          description="选择一个或多个 exe，或者扫描装着 galgame 的目录。"
          action={
            <Button onClick={() => setScanOpen(true)}>添加游戏</Button>
          }
        />
      ) : !loading && visibleGames.length === 0 ? (
        <EmptyState
          title="没有匹配的游戏"
          description="换个关键词，或清除当前筛选条件。"
          action={
            <Button variant="outline" onClick={resetFilters}>
              清除筛选
            </Button>
          }
        />
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {visibleGames.map((game) => (
            <GameCard
              key={game.id}
              game={game}
              tags={(tagsByGame.get(game.id) ?? [])
                .map((tagId) => tagById.get(tagId))
                .filter((tag): tag is Tag => tag !== undefined)}
              onToggleFavorite={(target) => void toggleFavorite(target)}
              selectable={selectMode}
              selected={selectedIds.has(game.id)}
              onToggleSelected={toggleSelected}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="hidden items-center gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground md:flex">
            {selectMode ? <span className="w-4" /> : null}
            <span className="w-8" />
            <span className="flex-1">标题</span>
            <span className="w-32">开发商</span>
            <span className="w-24">状态</span>
            <span className="w-14 text-right">评分</span>
            <span className="w-24 text-right">游玩时长</span>
            <span className="w-28 text-right">最近游玩</span>
            {!selectMode ? <span className="w-20 text-center">封面</span> : null}
            <span className="w-8" />
          </div>
          {visibleGames.map((game) => (
            <GameRow
              key={game.id}
              game={game}
              tags={(tagsByGame.get(game.id) ?? [])
                .map((tagId) => tagById.get(tagId))
                .filter((tag): tag is Tag => tag !== undefined)}
              onToggleFavorite={(target) => void toggleFavorite(target)}
              selectable={selectMode}
              selected={selectedIds.has(game.id)}
              onToggleSelected={toggleSelected}
            />
          ))}
        </div>
      )}

      <ScanDialog
        open={scanOpen}
        onClose={() => {
          setScanOpen(false);
          setPendingScanRoots(null);
        }}
        onConfirmed={handleConfirmed}
        initialRoots={pendingScanRoots ?? undefined}
      />
      {shareOpen ? <Suspense fallback={<p role="status" className="text-xs text-muted-foreground">正在打开分享…</p>}><ShareDialog games={games} onClose={() => setShareOpen(false)} /></Suspense> : null}

      {metadataGame ? (
        <MetadataDialog
          key={metadataGame.installPath}
          open
          draft={metadataGame}
          installPath={metadataGame.installPath}
          initialQuery={metadataGame.title}
          autoSearchOnOpen={!customImportPaths.has(metadataGame.installPath)}
          initialMode={customImportPaths.has(metadataGame.installPath) ? "manual" : "search"}
          progressLabel={`导入 ${importTotal - metadataQueue.length + 1} / ${importTotal}`}
          onClose={finishMetadataStep}
          onCreated={handleCreated}
          onCancelBatch={() => setMetadataQueue([])}
        />
      ) : null}

      {batchDrafts ? <BatchImportDialog drafts={batchDrafts} onFinished={handleBatchFinished}
        onClose={() => setBatchDrafts(null)} onManual={handleBatchManual} /> : null}

      {/*
        Bulk-delete confirmation. The body names the games rather than only
        counting them, because a count cannot reveal that the selection contains
        something you did not mean to tick. Only the database rows go — the
        folders on disk are left alone, which the description says outright.
      */}
      <ConfirmDialog
        open={confirmBulkDelete}
        title={`删除选中的 ${selectedIds.size} 部游戏？`}
        description={
          <span className="flex flex-col gap-2">
            <span>
              将删除这些游戏的库记录、标签关联与游玩历史。
              <strong className="text-foreground">
                磁盘上的游戏文件不会被删除。
              </strong>
              此操作不可撤销。
            </span>
            <span className="max-h-40 overflow-y-auto rounded border border-border bg-background/60 p-2 text-xs">
              {selectedGames.slice(0, 30).map((game) => (
                <span key={game.id} className="block truncate">
                  · {game.title}
                </span>
              ))}
              {selectedGames.length > 30 ? (
                <span className="mt-1 block text-muted-foreground">
                  …以及其余 {selectedGames.length - 30} 部
                </span>
              ) : null}
            </span>
          </span>
        }
        confirmText={deleting ? "删除中…" : "确认删除"}
        cancelText="取消"
        destructive
        busy={deleting}
        onConfirm={() => void bulkDelete()}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </div>
  );
}
