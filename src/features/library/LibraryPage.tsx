import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from 'react-router-dom';

import { loadInstallationState, useInstallationStore } from "@/features/installation/store";
import { matchesInstallation } from "@/features/installation/model";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LabeledSelect } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { GeometryIcon } from '@/components/ui/geometry-icon';
import { useLocalizedTags } from "@/lib/localization";
import {
  gamesDelete,
  gamesList,
  gamesStats,
  gamesTagsGet,
  tagsList,
  gameUpdate,
  settingsGet,
  settingsSet,
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
import { normalizeFilters, visibleSelection } from "./preferences";
import type { LibraryFilters } from "./preferences";
import type { GameStatus } from "@/types/game";

import { GameCard } from "./GameCard";
import { GameRow } from "./GameRow";
import { libraryRenderCount, LIBRARY_RENDER_BATCH } from './render-window';
import { FolderPanel } from "./FolderPanel";
import { FolderTile } from './FolderTile';
import { FolderGamePicker } from './FolderGamePicker';
import { FolderMoveDialog } from './FolderMoveDialog';
import { canResetFolder, folderStatistics, moveFolder, replaceFolderGames, resetEmptyFolder } from './folder-operations';
import { useFolderDrag } from './useFolderDrag';
import { assignFolder, FOLDERS_KEY, matchesFolder, parseFolders, groupBySociety, matchesSociety, folderPath, getFolderMode, selectFolderMode } from "./folders";
import type { LibraryFolder } from "./folders";
import ScanDialog from "@/features/scan/ScanDialog";
import BatchImportDialog from "@/features/scan/BatchImportDialog";
import type { PendingImport } from "@/features/scan/BatchImportDialog";
import { takePendingScanRoots } from "@/features/scan/pendingScan";
import MetadataDialog from "@/features/metadata/MetadataDialog";

let libraryScrollTop = 0;
let folderScrollTop = 0;
const rememberedRenderCounts = new Map<string, number>();

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

export default function LibraryPage({ folderPage = false }: { folderPage?: boolean }) {
  const [folderParams, setFolderParams] = useSearchParams();
  const folderTab = folderParams.get('tab') === 'custom' ? 'custom' : folderParams.get('tab') === 'status' ? 'status' : 'society';
  const activeFolder = folderTab === 'custom' ? folderParams.get('folder') ?? '' : '';
  const activeSociety = folderParams.get('society');
  const statusParam = folderParams.get('status');
  const activeStatus = statusParam && (statusParam === 'waiting' || GAME_STATUSES.some(status => status === statusParam)) ? statusParam : null;
  const customFolderView = folderPage && folderTab === 'custom' && Boolean(activeFolder);
  const setActiveFolder = (id: string) => setFolderParams({tab:'custom',folder:id});
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
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const customMode = customFolderView ? getFolderMode(folders,activeFolder) : null;
  const folderOverview = folderPage && (folderTab === 'society' && activeSociety === null || folderTab === 'status' && activeStatus === null || customFolderView && customMode !== 'games' && customMode !== 'mixed');
  const [pickerFolderId, setPickerFolderId] = useState<string | null>(null);
  const [movingFolderId,setMovingFolderId]=useState<string|null>(null);
  const [folderUndo,setFolderUndo]=useState<{before:LibraryFolder[];after:string;revision:number;message:string}|null>(null);
  useEffect(() => { setPickerFolderId(null);setMovingFolderId(null); }, [activeFolder, folderTab]);
  useEffect(()=>{if(!folderUndo)return;const timer=window.setTimeout(()=>setFolderUndo(null),8000);return()=>window.clearTimeout(timer);},[folderUndo]);
  const [folderTarget, setFolderTarget] = useState('');
  const [folderBusy, setFolderBusy] = useState(false);
  const [foldersLoaded, setFoldersLoaded] = useState(false);
  const folderSaving = useRef(false);
  const folderRevision = useRef(0);

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
    const remember = () => { if (folderPage) folderScrollTop = main.scrollTop; else libraryScrollTop = main.scrollTop; };
    main.addEventListener("scroll", remember);
    return () => { main.removeEventListener("scroll", remember); };
  }, [folderPage]);
  useEffect(() => {
    if (loading || restoredScroll.current) return;
    const saved = folderPage ? folderScrollTop : libraryScrollTop;
    const frame = requestAnimationFrame(() => {
      const main = rootRef.current?.closest("main");
      if (main) main.scrollTop = saved;
      restoredScroll.current = true;
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, folderPage]);
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
  const [notice, setNotice] = useState<{ message: string } | null>(null);
  const importNotice = notice?.message ?? null;
  // A new object also restarts the timeout for consecutive identical messages.
  const setImportNotice = useCallback((message: string | null) => setNotice(message === null ? null : {message}), []);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 3000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => { setNotice(null); }, [activeFolder, folderTab, activeStatus, activeSociety]);
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
    const revision = folderRevision.current;
    setLoading(true);
    setError(null);
    try {
      const [nextGames, nextTags, nextLinks, nextStats, , savedFolders] = await Promise.all([
        gamesList(),
        tagsList(),
        gamesTagsGet(),
        gamesStats(),
        loadInstallationState(),
        folderPage ? settingsGet(FOLDERS_KEY) : Promise.resolve(null),
      ]);
      setGames(nextGames);
      setTags(nextTags);
      setLinks(nextLinks);
      setStats(nextStats);
      if (!folderSaving.current && revision === folderRevision.current) {
        setFolders(parseFolders(savedFolders));
        setFoldersLoaded(true);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [folderPage]);

  const saveFolders = async (next: LibraryFolder[]): Promise<boolean> => {
    if (folderSaving.current || !foldersLoaded) return false;
    folderSaving.current = true;
    setFolderUndo(null);
    folderRevision.current += 1;
    setFolderBusy(true);
    setError(null);
    try {
      await settingsSet(FOLDERS_KEY, JSON.stringify(next));
      folderRevision.current += 1;
      setFolders(next);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally { folderSaving.current = false; setFolderBusy(false); }
  };

  const commitFolderOperation=async(next:LibraryFolder[],message:string):Promise<boolean>=>{
    if(JSON.stringify(next)===JSON.stringify(folders))return true;
    const before=folders;
    if(!await saveFolders(next))return false;
    setImportNotice(null);
    setFolderUndo({before,after:JSON.stringify(next),revision:folderRevision.current,message});
    return true;
  };
  const undoFolderOperation=async()=>{
    if(!folderUndo||folderSaving.current)return;
    if(folderUndo.revision!==folderRevision.current||folderUndo.after!==JSON.stringify(folders)){
      setFolderUndo(null);setError('分类已发生其他更改，不能撤销旧操作。');return;
    }
    if(await saveFolders(folderUndo.before))setImportNotice('已撤销文件夹操作。');
  };

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
  const societyFolders = useMemo(() => groupBySociety(games), [games]);
  const statusFolders = useMemo(() => [
    ...GAME_STATUSES.map(value => ({value, name:GAME_STATUS_LABELS[value], count:games.filter(game => game.status === value).length})),
    {value:'waiting',name:'待开始',count:games.filter(game => game.status === 'unplayed' || game.status === 'wishlist').length},
  ], [games]);
  const childFolders = useMemo(() => folders.filter(folder => folder.parentId === activeFolder), [folders, activeFolder]);
  const existingGameIds = useMemo(() => new Set(games.map(game => game.id)), [games]);
  const currentFolderGameCount = folders.find(folder => folder.id === activeFolder)?.gameIds.filter(id => existingGameIds.has(id)).length ?? 0;
  const folderStats=useMemo(()=>folderStatistics(folders,existingGameIds),[folders,existingGameIds]);
  const folderDrag=useFolderDrag({folders,available:existingGameIds,busy:!foldersLoaded||folderBusy||loading||batchBusy,scopeKey:folderPage?folderParams.toString():'library',
    commit:commitFolderOperation,onError:setError});

  const visibleGames = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const filtered = games.filter((game) => {
      if (folderPage && folderTab === 'custom' && !matchesFolder(folders, activeFolder, game.id)) return false;
      if (folderPage && folderTab === 'society' && activeSociety !== null && !matchesSociety(activeSociety, game)) return false;
      if (folderPage && folderTab === 'status' && activeStatus !== null && (activeStatus === 'waiting' ? game.status !== 'unplayed' && game.status !== 'wishlist' : game.status !== activeStatus)) return false;
      if (!matchesInstallation(installation, Boolean(archived[game.id]))) return false;
      if (needle) {
        const haystack = [game.title, game.originalTitle, game.developer]
          .filter((value): value is string => Boolean(value))
          .join("\n")
          .toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (!(folderPage && folderTab === 'status' && activeStatus) && status && game.status !== status) return false;
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
    folders,
    activeFolder,
    folderPage,
    folderTab,
    activeSociety,
    activeStatus,
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

  const renderScope = JSON.stringify([folderPage, folderParams.toString(), search, status, favoriteOnly, developer, activeTagIds, installation, sortKey, sortDirection]);
  const [renderState, setRenderState] = useState(() => ({ scope: renderScope, count: rememberedRenderCounts.get(renderScope) ?? LIBRARY_RENDER_BATCH }));
  const renderCount = libraryRenderCount(visibleGames.length, renderState.scope === renderScope ? renderState.count : rememberedRenderCounts.get(renderScope));
  const renderedGames = visibleGames.slice(0, renderCount);
  const revealMore = () => {
    const count = libraryRenderCount(visibleGames.length, renderCount + LIBRARY_RENDER_BATCH);
    rememberedRenderCounts.set(renderScope, count);
    if (rememberedRenderCounts.size > 30) rememberedRenderCounts.delete(rememberedRenderCounts.keys().next().value!);
    setRenderState({ scope: renderScope, count });
  };

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
  const pageTitle = !folderPage ? '游戏库'
    : customFolderView ? folders.find(folder => folder.id === activeFolder)?.name ?? (loading ? '载入中…' : '文件夹不存在')
    : folderTab === 'status' ? statusFolders.find(folder => folder.value === activeStatus)?.name ?? '游玩状态'
    : activeSociety !== null ? activeSociety || '未知社团' : '按社团分类';

  return (
    <div ref={rootRef} className="flex flex-col gap-3 px-4 py-3" data-library-state={loading ? "loading" : error ? "error" : "ready"}>
      {/* Header ---------------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className={folderPage ? 'min-w-[180px] flex-1' : undefined}>
          <h1 className={cn('flex min-w-0 items-start gap-2 font-semibold tracking-tight', folderPage ? 'text-xl' : 'text-lg')} title={pageTitle}>
            {folderPage ? <GeometryIcon name="folder" className="mt-1 size-5 text-primary" /> : null}
            <span className="min-w-0 break-words [overflow-wrap:anywhere]">{pageTitle}</span>
          </h1>
          <p className="text-xs text-muted-foreground">
            {customFolderView ? (loading ? '载入中…' : customMode === null ? '请选择创建子文件夹或直接添加游戏' : customMode === 'folders' ? `${childFolders.length} 个子文件夹 · 共 ${folderStats.get(activeFolder)?.gameCount??0} 部游戏（含下级，已去重）` : customMode === 'games' ? `本文件夹 ${currentFolderGameCount} 部游戏` : `${childFolders.length} 个子文件夹 · 共 ${folderStats.get(activeFolder)?.gameCount??0} 部游戏`) : folderPage && folderOverview ? (loading ? '载入中…' : folderTab === 'status' ? `按游玩状态自动分类 · ${games.length} 部游戏` : `按社团自动分类 · ${societyFolders.length} 个社团 · ${games.length} 部游戏`) : loading
              ? "载入中…"
              : `共 ${stats?.total ?? games.length} 部 · 显示 ${visibleGames.length} 部` +
                (stats && stats.playTimeSeconds > 0
                  ? ` · 累计 ${formatPlayTime(stats.playTimeSeconds)}`
                  : "")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          {!folderOverview ? <div className="inline-flex rounded-md bg-muted p-1">
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
          </div> : null}
          {!customFolderView || customMode === 'games' || customMode === 'mixed' ? <Button onClick={() => setScanOpen(true)}>添加游戏</Button> : null}
          {!folderOverview ? <Button variant="outline" disabled={loading} onClick={() => setShareOpen(true)}>分享足迹</Button> : null}
          {!folderOverview && (selectMode ? (
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
          ))}
          <Button variant="outline" disabled={folderBusy} onClick={() => void reload()} loading={loading}>
            刷新
          </Button>
        </div>
      </div>

      {folderPage ? <>
        <FolderPanel folders={folders} active={activeFolder} society={folderTab === 'society'} statusMode={folderTab === 'status'} busy={!foldersLoaded || folderBusy || loading || batchBusy}
          dropProps={folderDrag.targetProps} canReset={canResetFolder(folders,activeFolder,existingGameIds)}
          onReset={async()=>{const next=resetEmptyFolder(folders,activeFolder,existingGameIds);if(await saveFolders(next)){setImportNotice('已重置为空文件夹，可重新选择类型。');return true;}return false;}}
          onMove={()=>setMovingFolderId(activeFolder)}
          onClassify={() => { void (async () => {
            try {
              if (getFolderMode(folders,activeFolder) === 'games' || getFolderMode(folders,activeFolder) === 'mixed' || await saveFolders(selectFolderMode(folders,activeFolder,'games'))) {
                setLibraryFilters(normalizeFilters({}));
                setPickerFolderId(activeFolder);
              }
            } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
          })(); }}
          onStatus={() => { exitSelectMode(); setFolderParams({tab:'status'}); }} onSociety={() => { exitSelectMode(); setFolderParams({}); }} onSelect={id => { exitSelectMode(); setActiveFolder(id); }} onSave={saveFolders} />
        {customFolderView ? (childFolders.length ? <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3" aria-label="子文件夹">
          {childFolders.map(folder => <FolderTile key={folder.id} name={folder.name} count={folderStats.get(folder.id)?.gameCount??0} interaction={folderDrag.targetProps(folder.id)}
            description={`${folderStats.get(folder.id)?.childCount??0} 个子文件夹 · 共 ${folderStats.get(folder.id)?.gameCount??0} 部游戏`}
            onClick={() => { exitSelectMode(); setActiveFolder(folder.id); }} />)}
        </div> : null) : folderOverview && folderTab === 'status' ? <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {statusFolders.map(folder => <FolderTile key={folder.value} name={folder.name} count={folder.count} onClick={() => { setLibraryFilters(normalizeFilters({})); setFolderParams({tab:'status',status:folder.value}); }} />)}
        </div> : folderOverview ? <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {societyFolders.map(folder => <FolderTile key={folder.value} name={folder.name} count={folder.gameIds.length} onClick={() => setFolderParams({society:folder.value})} />)}
            {!loading && games.length === 0 ? <p className="text-sm text-muted-foreground">添加游戏后，会自动按社团分类。</p> : null}
          </div> : folderTab === 'society' ? <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => { exitSelectMode(); setFolderParams({}); }}>← 返回社团</Button>
          </div> : folderTab === 'status' ? <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => { exitSelectMode(); setFolderParams({tab:'status'}); }}>← 返回游玩状态</Button>
          </div> : null}
      </> : null}
      {folderDrag.hint ? <p role="status" className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-sm">{folderDrag.hint}</p> : null}
      {folderUndo ? <div role="status" className="flex items-center gap-3 rounded-md border border-border bg-accent px-3 py-2 text-sm">
        <span className="flex-1">{folderUndo.message}</span><Button size="sm" variant="outline" disabled={folderBusy||loading} onClick={()=>void undoFolderOperation()}>撤销</Button>
      </div> : null}

      {/*
        Selection bar. Only rendered in select mode, directly under the header so
        it is impossible to miss what is about to be deleted.
      */}
      {selectMode && !folderOverview ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
          <span className="text-sm font-medium">
            已选 {selectedIds.size} 部
          </span>
          <span className="text-xs text-muted-foreground">
            （当前显示 {visibleGames.length} 部）
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2" aria-busy={batchBusy}>
            {folderPage ? <><LabeledSelect label="批量文件夹" className="w-48" value={folderTarget} onValueChange={setFolderTarget} options={[{value:'',label:'选择文件夹'}, ...folders.filter(folder => getFolderMode(folders,folder.id) !== 'folders' && getFolderMode(folders,folder.id) !== 'mixed').map(folder => ({value:folder.id,label:folderPath(folders, folder.id).map(item => item.name).join(' / ')}))]} />
            <Button variant="outline" disabled={!foldersLoaded || !selectedGames.length || !folders.some(folder => folder.id === folderTarget && getFolderMode(folders,folder.id) !== 'folders' && getFolderMode(folders,folder.id) !== 'mixed') || folderBusy || batchBusy || loading}
              onClick={() => { void (async () => {
                const ids = visibleSelection(selectedIds, visibleGames);
                if (await saveFolders(assignFolder(folders, folderTarget, ids, true))) setImportNotice(`已将 ${ids.length} 部游戏加入文件夹。`);
              })(); }}>加入文件夹</Button>
            <Button variant="outline" disabled={!foldersLoaded || !selectedGames.length || !folders.some(folder => folder.id === activeFolder) || folderBusy || batchBusy || loading}
              onClick={() => { void (async () => {
                const ids = visibleSelection(selectedIds, visibleGames);
                if (await saveFolders(assignFolder(folders, activeFolder, ids, false))) setImportNotice(`已将 ${ids.length} 部游戏移出当前文件夹。`);
              })(); }}>移出当前文件夹</Button></> : null}
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
      {!folderOverview && stats && stats.total > 0 ? (
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
      {!folderOverview ? <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2">
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
            value={folderPage && folderTab === 'status' && activeStatus ? activeStatus : status}
            disabled={folderPage && folderTab === 'status' && activeStatus !== null}
            onValueChange={setStatus}
            options={[...STATUS_OPTIONS, ...(folderPage && folderTab === 'status' && activeStatus === 'waiting' ? [{value:'waiting',label:'待开始'}] : [])]}
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

      </div> : null}

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
      {folderOverview ? null : !loading && games.length === 0 ? (
        <EmptyState
          title="游戏库还是空的"
          description="选择一个或多个 exe，或者扫描装着 galgame 的目录。"
          action={
            <Button onClick={() => setScanOpen(true)}>添加游戏</Button>
          }
        />
      ) : !loading && visibleGames.length === 0 ? (
        <EmptyState
          title={folderPage && folderTab === 'custom' && !hasFilters ? '此文件夹内暂无游戏' : '没有匹配的游戏'}
          description={customFolderView && !hasFilters ? '点击「直接添加游戏」，从库中选择游戏加入当前文件夹。' : '换个关键词，或清除当前筛选条件。'}
          action={
            <Button variant="outline" disabled={customFolderView && (!foldersLoaded || folderBusy || loading)} onClick={customFolderView && !hasFilters ? () => setPickerFolderId(activeFolder) : resetFilters}>
              {customFolderView && !hasFilters ? '直接添加游戏' : '清除筛选'}
            </Button>
          }
        />
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
          {renderedGames.map((game) => (
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
              dragInteraction={folderPage?folderDrag.gameProps(selectedIds.has(game.id)?visibleSelection(selectedIds,visibleGames):[game.id]):undefined}
            />
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card" role="region" aria-label="游戏列表，可横向滚动" tabIndex={0}>
          <div className="min-w-[1100px]">
          <div className="flex items-center gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground">
            {selectMode ? <span className="w-4 shrink-0" /> : null}
            <span className="w-8 shrink-0" />
            <span className="min-w-[220px] flex-1">标题</span>
            <span className="w-32 shrink-0">开发商</span>
            <span className="w-24 shrink-0">状态</span>
            <span className="w-14 shrink-0 text-right">评分</span>
            <span className="w-24 shrink-0 text-right">游玩时长</span>
            <span className="w-28 shrink-0 text-right">最近游玩</span>
            {!selectMode ? <span className="w-20 shrink-0 text-center">封面</span> : null}
            <span className="w-8 shrink-0" />
          </div>
          {renderedGames.map((game) => (
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
              dragInteraction={folderPage?folderDrag.gameProps(selectedIds.has(game.id)?visibleSelection(selectedIds,visibleGames):[game.id]):undefined}
            />
          ))}
          </div>
        </div>
      )}

      {!loading && renderCount < visibleGames.length && !folderOverview ? <div className="flex flex-col items-center gap-2 py-4">
        <Button variant="outline" onClick={revealMore}>加载更多（已显示 {renderCount} / {visibleGames.length}）</Button>
        <p className="text-xs text-muted-foreground">搜索、筛选和全选仍覆盖全部 {visibleGames.length} 部匹配游戏。</p>
      </div> : null}

      <ScanDialog
        open={scanOpen}
        onClose={() => {
          setScanOpen(false);
          setPendingScanRoots(null);
        }}
        onConfirmed={handleConfirmed}
        initialRoots={pendingScanRoots ?? undefined}
      />
      {pickerFolderId && folders.some(folder => folder.id === pickerFolderId) ? <FolderGamePicker
        key={pickerFolderId} folder={folders.find(folder => folder.id === pickerFolderId)!} games={games} busy={folderBusy}
        onClose={() => setPickerFolderId(null)} onSave={async ids => {
          const result=replaceFolderGames(folders,pickerFolderId,ids,existingGameIds);
          const saved=await saveFolders(result.folders);
          if(saved){setLibraryFilters(normalizeFilters({}));setImportNotice(`已保存归类：新增 ${result.added} 部，移出 ${result.removed} 部。`);}
          return saved;
        }} /> : null}
      {movingFolderId ? <FolderMoveDialog key={movingFolderId} folderId={movingFolderId} folders={folders} busy={folderBusy||loading} onClose={()=>setMovingFolderId(null)}
        onMove={async(parentId,beforeId)=>commitFolderOperation(moveFolder(folders,movingFolderId,parentId,beforeId),'已移动文件夹。')} /> : null}
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
