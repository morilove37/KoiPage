import { BangumiSyncProfilePanel } from "@/features/bangumi-sync/BangumiSyncProfilePanel";
import type { SyncReport } from "@/features/bangumi-sync/api";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@/lib/logging";

import { Badge } from "@/components/ui/badge";
import { useToast } from "@/components/Toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { CoverImage } from "@/components/ui/cover-image";
import { CoverControls } from "@/features/covers/CoverControls";
import { ArchivePanel } from '@/features/installation/ArchivePanel';
import { useGameInstallation } from '@/features/installation/store';
import { SaveBackupPanel } from '@/features/save-backups/SaveBackupPanel';
import { useCoverCropEditor } from "@/features/covers/CoverCropEditor";
import { useGameCover } from "@/features/covers/store";
import { effectiveCoverPath } from "@/features/covers/model";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { PathInput } from "@/components/ui/path-input";
import { Select } from "@/components/ui/select";
import { Tabs } from "@/components/ui/tabs";
import LaunchDialog from "@/features/launch/LaunchDialog";
import { useGameLauncher } from "@/features/launch/useGameLauncher";
import { useGameProcess } from "@/features/launch/useGameProcess";
import { LaunchProfilePanel } from '@/features/launch/LaunchProfilePanel';
import MetadataDialog from "@/features/metadata/MetadataDialog";
import { errorMessage } from "@/features/io/io";
import type { GameExitedPayload } from "@/features/io/io";
import {
  gameDelete,
  gameGet,
  gameUpdate,
  playSessionsList,
  tagsList,
} from "@/lib/db";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/app";
import { useLocalizedTags } from "@/lib/localization";
import { formatRating, roundRating } from "@/lib/rating";
import { isGameOpeningTransition, returnFromGameWithTransition } from "@/lib/game-opening";
import {
  GAME_STATUSES,
  GAME_STATUS_LABELS,
  formatPlayTime,
  isFavorite,
} from "@/types/game";
import type { GameDetail, GamePatch, GameStatus, PlaySession, Tag } from "@/types/game";

import { TagSelector } from "./TagSelector";
import PlayHistoryPanel from "./PlayHistoryPanel";
import { GuidePanel } from "./GuidePanel";
import { RelationsPanel } from "./RelationsPanel";
import { detailFields, detailPatchFor, launchPathUnavailable } from "./detail-edits";
import type { DetailSection, GamePathState } from "./detail-edits";

/** Form state: every field is a string so inputs stay controlled and empty-able. */
interface FormState {
  title: string;
  originalTitle: string;
  developer: string;
  releaseDate: string;
  rating: string;
  coverPath: string;
  description: string;
  installPath: string;
  exePath: string;
  launchArgs: string;
  workdir: string;
  savePath: string;
  notes: string;
  vndbId: string;
  twodfanId: string;
}

function toForm(game: GameDetail): FormState {
  return {
    title: game.title,
    originalTitle: game.originalTitle ?? "",
    developer: game.developer ?? "",
    releaseDate: game.releaseDate ?? "",
    rating: game.rating === null ? "" : formatRating(game.rating),
    coverPath: game.coverPath ?? "",
    description: game.description ?? "",
    installPath: game.installPath,
    exePath: game.exePath ?? "",
    launchArgs: game.launchArgs ?? "",
    workdir: game.workdir ?? "",
    savePath: game.savePath ?? "",
    notes: game.notes ?? "",
    vndbId: game.vndbId ?? "",
    twodfanId: game.twodfanId ?? "",
  };
}

/** `''` -> null (clears the column); otherwise the trimmed string. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "从未";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", { hour12: false });
}

/** Batch launchers (.bat/.cmd) are started through cmd.exe, not directly. */
function isScriptPath(value: string): boolean {
  return /\.(bat|cmd)$/i.test(value.trim());
}

export default function GameDetailPage() {
  const sharedOpening = useRef<boolean | null>(null);
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const gameId = Number(id);
  const installation = useGameInstallation(gameId);
  const { preferences: coverPreferences } = useGameCover(gameId);
  const playTimeRevision = useAppStore((s) => s.playTimeRevision);

  const [game, setGame] = useState<GameDetail | null>(null);
  const [coverSize, setCoverSize] = useState<{ path: string | null; width: number; height: number } | null>(null);
  const cropEditor = useCoverCropEditor({ gameId, sourcePath: game?.coverPath ?? null, title: game?.title ?? '', dimensions: coverSize });
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [sessions, setSessions] = useState<PlaySession[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const formBaseline = useRef<FormState | null>(null);
  const tagBaseline = useRef<number[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [pendingTagNames, setPendingTagNames] = useState<string[]>([]);
  const [tagError, setTagError] = useState<string | null>(null);
  const [tab, setTab] = useState("info");
  const contentRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const moreActions = useRef<HTMLDetailsElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const [editingInfo, setEditingInfo] = useState(false);
  const [expandedDescription, setExpandedDescription] = useState(false);
  const [expandedTags, setExpandedTags] = useState(false);
  const [pathCheck, setPathCheck] = useState<{ key: string; state?: GamePathState } | null>(null);
  const [choosingLauncher, setChoosingLauncher] = useState(false);

  useEffect(() => {
    setEditingInfo(false);
    setExpandedDescription(false);
    setExpandedTags(false);
  }, [gameId]);

  useEffect(() => {
    const requested = searchParams.get("tab");
    setTab(requested && ["info", "guide", "files", "tags", "history", "saves"].includes(requested) ? requested : "info");
    contentRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [searchParams]);

  useEffect(() => {
    const tabs = tabsRef.current;
    if (tabs && tabs.scrollWidth > tabs.clientWidth) {
      tabs.querySelector('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [game?.id, tab]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [statusSaving, setStatusSaving] = useState(false);
  const statusPending = useRef(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  /** Set once metadata was written, so closing the dialog triggers one reload. */
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [confirmMetadata, setConfirmMetadata] = useState(false);
  const process = useGameProcess(gameId);
  const launching = process.status === "starting";
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  const checkedPathKey = JSON.stringify([game?.id, game?.exePath, game?.installPath]);
  const savedGameId = game?.id;
  useEffect(() => {
    if (!savedGameId || savedGameId !== gameId) return;
    let live = true;
    let request = 0;
    const check = () => {
      const current = ++request;
      void invoke<Array<{ state: GamePathState }>>("game_paths_check", { gameId }).then(rows => {
        if (live && current === request) setPathCheck({ key: checkedPathKey, state: rows[0]?.state });
      }).catch(() => {});
    };
    check();
    window.addEventListener("focus", check);
    return () => { live = false; window.removeEventListener("focus", check); };
  }, [checkedPathKey, gameId, savedGameId]);

  /**
   * Whether this detail view can pop the history stack. A game opened from the
   * library list gets `history.state.idx > 0`, so `navigate(-1)` returns to the
   * exact list position/filters the user came from. A deep link or a reload
   * starts at idx 0, where going back would leave the app — so those fall back
   * to the library route instead.
   */
  const canGoBackRef = useRef(false);
  if (!canGoBackRef.current) {
    const idx = (window.history.state as { idx?: number } | null)?.idx;
    canGoBackRef.current = typeof idx === "number" && idx > 0;
  }
  const { t } = useLocalizedTags();

  const load = useCallback(async () => {
    if (!Number.isFinite(gameId)) {
      setError(`无效的游戏 ID：${id ?? ""}`);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const [detail, tagList, sessionList] = await Promise.all([
        gameGet(gameId),
        tagsList(),
        playSessionsList(gameId, 50),
      ]);
      setGame(detail);
      setAllTags(tagList);
      setSessions(sessionList);
      const draft = toForm(detail);
      formBaseline.current = draft;
      tagBaseline.current = detail.tags;
      setForm(draft);
      setSelectedTagIds(detail.tags);
      setNewTagName("");
      setPendingTagNames([]);
      setTagError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [gameId, id]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Back out of the detail view, preferring the real previous page. */
  const goBack = useCallback(() => {
    // The decision is frozen at mount (`canGoBackRef`) so entries pushed *after*
    // this page opened — a tag link to /tags, say — cannot redirect 返回 to a
    // sibling page instead of the library the user came from.
    returnFromGameWithTransition(gameId, () => {
      if (canGoBackRef.current) navigate(-1);
      else navigate("/library");
    });
  }, [gameId, navigate]);

  /**
   * Re-read the game and its sessions **without** the full-page loading state.
   *
   * `load()` sets `loading`, and the render path early-returns a full-page
   * 「载入中…」 while it is true — which unmounts any open dialog. That is fine
   * for navigation but wrong when a launch or a process exit happens while the
   * launch dialog is on screen, so this lighter path keeps the modal alive and
   * just updates the numbers behind it.
   */
  const refreshQuietly = useCallback(async () => {
    if (!Number.isFinite(gameId)) return;
    try {
      const [detail, sessionList] = await Promise.all([
        gameGet(gameId),
        playSessionsList(gameId, 50),
      ]);
      setGame(detail);
      setSessions(sessionList);
    } catch {
      // A failed background refresh must not surface as a page error; the next
      // explicit action will retry.
    }
  }, [gameId]);

  const lastPlayTimeRevision = useRef(playTimeRevision);
  useEffect(() => {
    if (lastPlayTimeRevision.current === playTimeRevision) return;
    lastPlayTimeRevision.current = playTimeRevision;
    void refreshQuietly();
  }, [playTimeRevision, refreshQuietly]);

  const launcher = useGameLauncher(() => void refreshQuietly());

  useEffect(() => {
    let alive = true;
    let request = 0;
    let unlisten: UnlistenFn | undefined;
    void listen<SyncReport>('bangumi-sync-updated', ({ payload }) => {
      if (!alive || (payload.downloaded <= 0 && payload.errors <= 0)) return;
      const currentRequest = ++request;
      // Refresh saved state only; personal sync must never reset the draft.
      void gameGet(gameId).then(detail => {
        if (alive && currentRequest === request) setGame(detail);
      }).catch(() => {});
    }).then(cleanup => {
      if (alive) unlisten = cleanup; else cleanup();
    }).catch(() => {});
    return () => { alive = false; request++; unlisten?.(); };
  }, [gameId]);

  /**
   * Play time is accumulated by the Rust side when the launched process exits,
   * which then emits `game-exited`. Nothing was listening, so the displayed
   * 游玩时长 stayed stale until the page was navigated away from and back.
   */
  useEffect(() => {
    if (!Number.isFinite(gameId)) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void listen<GameExitedPayload>("game-exited", (event) => {
      if (event.payload.gameId !== gameId) return;
      void refreshQuietly();
    })
      .then((dispose) => {
        // The listener may resolve after unmount; dispose immediately in that case.
        if (cancelled) dispose();
        else unlisten = dispose;
      })
      .catch(() => {
        // Losing the live update is not fatal: the totals refresh on next load.
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [gameId, refreshQuietly]);

  const tagById = useMemo(() => {
    const map = new Map<number, Tag>();
    for (const tag of allTags) map.set(tag.id, tag);
    return map;
  }, [allTags]);

  const addTag = () => {
    if (saving) return;
    const name = newTagName.trim();
    if (!name) {
      setTagError("请输入标签名称。");
      return;
    }
    const key = name.toLowerCase();
    const original = allTags.find(tag => tag.name.toLowerCase() === key);
    const translated = allTags.filter(tag => t(tag.name).toLowerCase() === key);
    if (!original && translated.length > 1) {
      setTagError("多个已有标签显示为这个名称，请在下方选择对应标签。");
      return;
    }
    const existing = original ?? translated[0];
    if (existing) {
      setSelectedTagIds(current => current.includes(existing.id) ? current : [...current, existing.id]);
    } else {
      setPendingTagNames(current => current.some(item => item.toLowerCase() === key) ? current : [...current, name]);
    }
    setNewTagName("");
    setTagError(null);
  };

  /** Only fields the user actually changed, so a save never clobbers siblings. */
  const buildPatch = (): GamePatch | null => {
    const baseline = formBaseline.current;
    if (!form || !baseline) return null;
    const entries: Array<[keyof GamePatch, GamePatch[keyof GamePatch]]> = [];
    for (const field of [...detailFields.info, ...detailFields.files]) {
      const value = form[field].trim();
      if (value === baseline[field].trim()) continue;
      if (field === "rating") entries.push([field, value === "" ? null : roundRating(Number(value))]);
      else if (field === "title" || field === "installPath") entries.push([field, value]);
      else entries.push([field, orNull(value)]);
    }
    const patch: GamePatch = Object.fromEntries(entries);
    const currentTags = [...tagBaseline.current].sort((a, b) => a - b);
    const nextTags = [...selectedTagIds].sort((a, b) => a - b);
    if (currentTags.join(",") !== nextTags.join(",")) patch.tags = nextTags;
    if (pendingTagNames.length > 0) patch.tagNames = pendingTagNames;

    return patch;
  };

  function resetDraft(section: "info" | "files", source: GameDetail) {
    const restored = toForm(source);
    const fields: readonly (keyof FormState)[] = detailFields[section];
    const restoreSection = (current: FormState) => {
      const next = { ...current };
      for (const field of fields) next[field] = restored[field];
      return next;
    };
    if (formBaseline.current) formBaseline.current = restoreSection(formBaseline.current);
    setForm(current => current ? restoreSection(current) : current);
  }

  function closeInfoEditor() {
    setEditingInfo(false);
    requestAnimationFrame(() => editButton.current?.focus());
  }

  function cancelEdits(section: DetailSection) {
    if (!game || saving) return;
    setError(null);
    if (section === "tags") {
      tagBaseline.current = game.tags;
      setSelectedTagIds(game.tags);
      setPendingTagNames([]);
      setNewTagName("");
      setTagError(null);
    } else {
      resetDraft(section, game);
      if (section === "info") closeInfoEditor();
    }
  }

  const save = async (section: DetailSection) => {
    if (!game || !form || saving || statusPending.current) return;
    if (section === "info") {
      if (!form.title.trim()) { setError("标题不能为空。"); return; }
      const rating = Number(form.rating);
      if (form.rating.trim() && (!Number.isFinite(rating) || rating < 0 || rating > 10)) {
        setError("评分必须是 0-10 的数字，支持小数。");
        return;
      }
    }
    if (section === "files" && !form.installPath.trim()) { setError("安装路径不能为空。"); return; }
    const patch = detailPatchFor(buildPatch() ?? {}, section);
    if (!Object.keys(patch).length) return;

    setSaving(true);
    setError(null);
    try {
      const updated = await gameUpdate(gameId, patch);
      if (section === "tags") {
        const [detail, tagList] = await Promise.all([gameGet(gameId), tagsList()]);
        setGame(detail);
        setAllTags(tagList);
        tagBaseline.current = detail.tags;
        setSelectedTagIds(detail.tags);
        setPendingTagNames([]);
        setNewTagName("");
        setTagError(null);
      } else {
        setGame(current => current?.id === updated.id ? { ...current, ...updated } : current);
        resetDraft(section, { ...updated, tags: game.tags });
        if (section === "info") closeInfoEditor();
      }
      toast("已保存。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  };

  function selectTab(value: string) {
    setTab(value);
    contentRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }

  /** Open an external page (2DFan topic, VNDB entry) in the system browser. */
  function openExternal(url: string) {
    void openUrl(url).catch(cause => setError(errorMessage(cause)));
  }

  /** Bind a 2DFan subject to this game, then refresh so the guide list loads. */
  const bindTwodfanSubject = useCallback(async (subjectId: string) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await gameUpdate(gameId, { twodfanId: subjectId });
      setGame(current => current?.id === updated.id ? { ...current, ...updated } : current);
      if (formBaseline.current) formBaseline.current = { ...formBaseline.current, twodfanId: subjectId };
      setForm(current => current ? { ...current, twodfanId: subjectId } : current);
      toast("已绑定 2DFan 作品。");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }, [gameId, toast]);

  async function chooseLaunchFile() {
    if (!game || choosingLauncher) return;
    selectTab("files");
    setChoosingLauncher(true);
    setError(null);
    try {
      const path = await open({
        title: "选择游戏启动文件",
        defaultPath: game.installPath || undefined,
        filters: [{ name: "可执行文件或启动脚本", extensions: ["exe", "bat", "cmd"] }],
      });
      if (typeof path === "string") setForm(current => current ? { ...current, exePath: path } : current);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setChoosingLauncher(false);
    }
  }

  async function openInstallFolder() {
    setError(null);
    try {
      await invoke<void>("game_open_install_directory", { gameId });
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  const toggleFavorite = async () => {
    if (!game) return;
    const next = isFavorite(game) ? 0 : 1;
    setGame(current => current?.id === gameId ? { ...current, favorite: next } : current);
    try {
      await gameUpdate(gameId, { favorite: next });
    } catch (cause) {
      setGame(current => current?.id === gameId ? { ...current, favorite: game.favorite } : current);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const changeStatus = async (status: GameStatus) => {
    if (!game || status === game.status || saving || deleting || statusPending.current) return;
    statusPending.current = true;
    setStatusSaving(true);
    setError(null);
    void 0;
    try {
      const updated = await gameUpdate(gameId, { status });
      setGame(current => current?.id === gameId
        ? { ...current, status: updated.status, updatedAt: updated.updatedAt }
        : current);
      toast(`状态已更新为「${GAME_STATUS_LABELS[updated.status]}」。`);
    } catch (cause) {
      setError(`状态保存失败：${cause instanceof Error ? cause.message : String(cause)}`);
    } finally {
      statusPending.current = false;
      setStatusSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      await gameDelete(gameId);
      navigate("/library");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  /**
   * Opening the metadata dialog while the form holds unsaved edits is a trap:
   * applying metadata reloads the page and those edits would vanish silently.
   * Ask first instead.
   */
  const openMetadata = () => {
    const patch = buildPatch();
    if (patch && Object.keys(patch).length > 0) {
      setConfirmMetadata(true);
      return;
    }
    setMetadataOpen(true);
  };

  /**
   * Metadata writes go straight to the database, so the page has to refetch —
   * but only once the dialog is closed. Reloading while it is open would flip
   * this component to its `loading` early-return and unmount the dialog
   * mid-interaction.
   */
  const closeMetadata = () => {
    setMetadataOpen(false);
    if (!metadataDirty) return;
    setMetadataDirty(false);
    toast("已更新资料。");
    void load();
  };

  if (loading) {
    return (
      <div className="flex flex-col items-start gap-3 p-5" data-detail-state="loading" data-game-id={gameId}>
        <BackButton onClick={goBack} title="返回上一页" />
        <div className="text-sm text-muted-foreground">载入中…</div>
      </div>
    );
  }

  if (!game || !form) {
    return (
      <div className="flex flex-col items-start gap-3 p-5" data-detail-state="error" data-game-id={gameId}>
        <BackButton onClick={goBack} title="返回上一页" />
        <p className="text-sm text-destructive">
          无法载入游戏：{error ?? "未找到记录"}
        </p>
        <Link
          to="/library"
          className="text-sm text-primary underline-offset-4 hover:underline"
        >
          返回游戏库
        </Link>
      </div>
    );
  }

  // Decide once when content arrives, so a timed-out opening can fade in later
  // without making subsequent edits replay the entrance animation.
  if (sharedOpening.current === null) sharedOpening.current = isGameOpeningTransition();
  const favorite = isFavorite(game);
  const displayCoverPath = effectiveCoverPath(game.coverPath, coverPreferences);
  const dimensions = coverSize?.path === displayCoverPath ? coverSize : null;
  const landscape = Boolean(dimensions && dimensions.width > dimensions.height);
  const tags = selectedTagIds
    .map((tagId) => tagById.get(tagId))
    .filter((tag): tag is Tag => tag !== undefined);

  const pathState = pathCheck?.key === checkedPathKey ? pathCheck.state : undefined;
  const running = process.status === "running";
  const needsLauncher = !installation.archived && launchPathUnavailable(game.exePath, pathState, running);
  const description = game.description?.trim() || "";
  const longDescription = description.length > 180 || description.split("\n").length > 4;
  const previewTags = game.tags
    .map(id => tagById.get(id))
    .filter((tag): tag is Tag => tag !== undefined);
  const tagPreviewLimit = 8;
  const hiddenTagCount = previewTags.length - tagPreviewLimit;
  const visibleTags = expandedTags ? previewTags : previewTags.slice(0, tagPreviewLimit);
  const draftPatch = buildPatch() ?? {};
  const sectionActions = (section: DetailSection, label: string) => {
    const changed = Object.keys(detailPatchFor(draftPatch, section)).length > 0;
    return <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
      <span className="text-xs text-muted-foreground" aria-live="polite">{changed ? "有未保存的修改" : ""}</span>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={saving || (section !== "info" && !changed)} onClick={() => cancelEdits(section)}>取消</Button>
        <Button size="sm" loading={saving} disabled={!changed || statusSaving} onClick={() => void save(section)}>{label}</Button>
      </div>
    </div>;
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 px-3 py-4 sm:px-5" data-game-detail data-game-id={game.id}>
      {/* Header ---------------------------------------------------------- */}
      <div className="relative z-20 flex shrink-0 flex-col gap-2" data-detail-header>
        <div className="flex shrink-0 items-center gap-2">
          <BackButton
            onClick={goBack}
            title="返回上一页"
            aria-label="返回"
          />
          <Link
            to="/library"
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            游戏库
          </Link>
        </div>

        <div className="detail-hero rounded-xl border border-border bg-card px-4 py-3 sm:px-5" data-detail-toolbar>
          <div className="min-w-0 space-y-1">
            <h1 className="line-clamp-2 break-words text-xl font-semibold leading-tight tracking-tight sm:text-2xl" title={game.title}>
              {game.title}
            </h1>
            {game.originalTitle && game.originalTitle !== game.title ? (
              <p className="truncate text-xs text-muted-foreground sm:text-sm" title={game.originalTitle}>{game.originalTitle}</p>
            ) : null}
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <Select
              aria-label="游戏状态"
              className="w-24 shrink-0"
              value={game.status}
              disabled={statusSaving || saving || deleting}
              onValueChange={value => void changeStatus(value)}
              options={GAME_STATUSES.map(status => ({ value: status, label: GAME_STATUS_LABELS[status] }))}
            />
            <Button variant="outline" aria-pressed={favorite} onClick={() => void toggleFavorite()}>
              {favorite ? "★ 已收藏" : "☆ 收藏"}
            </Button>
            <details ref={moreActions} className="group relative z-20" onBlur={event => {
              if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
            }} onKeyDown={event => {
              if (event.key === "Escape" && event.currentTarget.open) {
                event.currentTarget.open = false;
                event.currentTarget.querySelector("summary")?.focus();
              }
            }}>
              <summary aria-label="更多操作" title="更多操作" className={buttonClassName({
                variant: "outline",
                size: "icon",
                className: "w-10 cursor-pointer list-none rounded-full text-sm font-semibold [&::-webkit-details-marker]:hidden",
              })}>···</summary>
              <div className="absolute right-0 top-full mt-1 grid w-36 gap-1 rounded-lg border border-border bg-background p-1.5 text-foreground shadow-lg [.glass_&]:border-glass-border [.glass_&]:bg-glass-strong [.glass_&]:shadow-glass-lg [.glass_&]:backdrop-blur-[var(--glass-blur)] [.glass_&]:backdrop-saturate-150">
                <Button size="sm" variant="ghost" className="justify-start" onClick={() => {
                  if (moreActions.current) {
                    moreActions.current.open = false;
                    moreActions.current.querySelector("summary")?.focus();
                  }
                  openMetadata();
                }}>联网获取资料</Button>
                <Button size="sm" variant="ghost" className="justify-start text-destructive hover:text-destructive" onClick={() => {
                  if (moreActions.current) {
                    moreActions.current.open = false;
                    moreActions.current.querySelector("summary")?.focus();
                  }
                  setConfirmDelete(true);
                }}>删除条目</Button>
              </div>
            </details>
            <Button
              className="min-w-[6rem]"
              loading={launching || choosingLauncher}
              disabled={!installation.loaded || installation.archived || saving}
              onClick={() => void (needsLauncher ? chooseLaunchFile() : launcher.launch(game))}
              title={installation.archived ? "请在「路径与启动」恢复为已安装" : undefined}
            >
              {installation.archived ? "已卸载" : launching ? "启动中…" : running ? "运行中" : needsLauncher ? "选择启动文件" : "启动游戏"}
            </Button>
          </div>
        </div>
      </div>

      <div
        className="shrink-0 overflow-x-auto rounded-xl p-0.5"
        ref={tabsRef}
      >
        <Tabs
          className="min-w-[26rem]"
          label="游戏详情分区"
          value={tab}
          onValueChange={selectTab}
          items={[
            { value: "info", label: "基本信息" },
            { value: "guide", label: "攻略与关联" },
            { value: "history", label: "游玩历史" },
            { value: "files", label: "路径与启动" },
            { value: "saves", label: "存档备份" },
            { value: "tags", label: "标签" },
          ]}
        />
      </div>

      <div ref={contentRef} className={`flex min-h-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto pb-3 [scrollbar-gutter:stable]${sharedOpening.current ? "" : " detail-content-enter"}`} data-detail-scroll>
      {installation.archived ? <div role="status" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
        <span>已卸载并归档 · 游戏资料、游玩历史和存档备份保留。</span>
        <Button size="sm" variant="outline" onClick={() => selectTab("files")}>重新指定路径与安装状态</Button>
      </div> : null}
      {needsLauncher ? <p role="status" className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs">
        {pathState === "offline" ? "安装磁盘未连接，可重新连接磁盘或选择启动文件。"
          : pathState === "missingFolder" ? "安装目录找不到，请核对安装路径和启动文件。"
          : game.exePath ? "找不到启动文件，请重新选择并保存路径。" : "尚未设置启动文件。"}
      </p> : null}
      {launcher.error ? <p role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">{launcher.error}</p> : null}
      {error && tab !== "files" && !(tab === "info" && editingInfo) ? (
        <div role="alert" className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}

      <div className="detail-layout grid items-start gap-3"
        data-detail-layout={landscape ? "landscape" : "portrait"}
        style={{ "--detail-cover-ratio": dimensions ? dimensions.width / dimensions.height : 3 / 4 } as CSSProperties}>
        {/* Cover --------------------------------------------------------- */}
        <Card className="h-fit min-w-0 rounded-xl">
          <CardContent className="detail-summary-content p-3 sm:p-4">
            <div className="min-w-0">
              <div data-detail-cover className="detail-cover-frame relative w-full overflow-hidden rounded-lg bg-muted">
                <CoverImage
                  gameId={game.id}
                  loading="eager"
                  path={game.coverPath}
                  alt={game.title}
                  className="h-full w-full object-contain"
                  onDimensions={size => setCoverSize(size ? { path: displayCoverPath, ...size } : null)}
                />
                {cropEditor.overlay}
              </div>
              <CoverControls gameId={game.id} sourcePath={game.coverPath} title={game.title} cropControls={cropEditor.controls} />
            </div>
            <div className="min-w-0 space-y-3">
              <dl data-detail-records className="detail-stats grid gap-2">
                <div>
                  <dt>游玩时长</dt>
                  <dd>{formatPlayTime(game.playTimeSeconds)}</dd>
                </div>
                <div>
                  <dt>评分</dt>
                  <dd className={game.rating === null ? undefined : "text-primary"}>{game.rating === null ? "未评分" : formatRating(game.rating)}</dd>
                </div>
                <div>
                  <dt>最近游玩</dt>
                  <dd>{formatDateTime(game.lastPlayedAt)}</dd>
                </div>
              </dl>
              <dl data-detail-metadata className="detail-metadata grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 border-t border-border pt-3 text-xs">
                <dt>开发商</dt>
                <dd>{game.developer || "未填写"}</dd>
                <dt>发售日</dt>
                <dd>{game.releaseDate || "未填写"}</dd>
                <dt>创建于</dt>
                <dd>{formatDateTime(game.createdAt)}</dd>
                <dt>更新于</dt>
                <dd>{formatDateTime(game.updatedAt)}</dd>
              </dl>
            </div>
          </CardContent>
        </Card>

        {/* Panels -------------------------------------------------------- */}
        <div className="min-w-0 space-y-3" data-detail-panel>
        {tab === "info" ? (
          <>
            <Card className="min-w-0 rounded-xl">
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 sm:px-5">
                <CardTitle className="text-base">{editingInfo ? "编辑资料" : "作品简介"}</CardTitle>
                {!editingInfo ? <Button ref={editButton} size="sm" variant="outline" onClick={() => {
                  setError(null);
                  resetDraft("info", game);
                  setEditingInfo(true);
                }}>编辑资料</Button> : null}
              </CardHeader>
              <CardContent className="sm:px-5 sm:pb-5">
                {editingInfo ? (
                  <fieldset disabled={saving} className="min-w-0 space-y-4">
                    <div data-detail-editor className="grid gap-3 sm:grid-cols-2">
                      <Field label="标题" className="sm:col-span-2"><Input autoFocus value={form.title} onChange={event => setForm({ ...form, title: event.target.value })} /></Field>
                      <Field label="原名"><Input value={form.originalTitle} onChange={event => setForm({ ...form, originalTitle: event.target.value })} /></Field>
                      <Field label="开发商"><Input value={form.developer} onChange={event => setForm({ ...form, developer: event.target.value })} /></Field>
                      <Field label="评分" hint="0–10，支持小数，留空表示未评分">
                        <Input type="number" min={0} max={10} step="0.01" value={form.rating} onChange={event => setForm({ ...form, rating: event.target.value })} />
                      </Field>
                      <Field label="发售日" hint="YYYY-MM-DD"><Input value={form.releaseDate} onChange={event => setForm({ ...form, releaseDate: event.target.value })} /></Field>
                      <Field label="简介" className="sm:col-span-2"><Textarea className="min-h-40" value={form.description} onChange={event => setForm({ ...form, description: event.target.value })} /></Field>
                      <Field label="原封面路径"><Input value={form.coverPath} onChange={event => setForm({ ...form, coverPath: event.target.value })} placeholder="本地绝对路径" /></Field>
                      <Field label="VNDB ID"><Input value={form.vndbId} onChange={event => setForm({ ...form, vndbId: event.target.value })} /></Field>
                      <Field label="2DFan 作品 ID" hint="在「攻略与关联」分区搜索绑定，也可直接填数字 ID">
                        <Input value={form.twodfanId} onChange={event => setForm({ ...form, twodfanId: event.target.value })} placeholder="例如 21" />
                      </Field>
                      <Field label="备注" className="sm:col-span-2"><Textarea value={form.notes} onChange={event => setForm({ ...form, notes: event.target.value })} /></Field>
                    </div>
                    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
                    {sectionActions("info", "保存资料")}
                  </fieldset>
                ) : (
                  <div className="space-y-3">
                    {description ? <>
                      <p id="game-description" className={cn("max-w-[72ch] whitespace-pre-wrap break-words text-sm leading-7", longDescription && !expandedDescription && "line-clamp-6")}>{description}</p>
                      {longDescription ? <Button size="sm" variant="ghost" className="px-0 text-primary" aria-expanded={expandedDescription} aria-controls="game-description" onClick={() => setExpandedDescription(value => !value)}>{expandedDescription ? "收起简介" : "展开简介"}</Button> : null}
                    </> : <p className="text-sm text-muted-foreground">暂无简介。可编辑资料，或在更多操作中联网获取。</p>}
                    {previewTags.length > 0 ? (
                      <div className="space-y-2 border-t border-border pt-3">
                        <div id="game-tag-preview" className="flex flex-wrap gap-1.5" aria-label="作品标签">
                          {visibleTags.map(tag => <Badge key={tag.id} color={tag.color} variant="outline" className="max-w-full whitespace-normal [overflow-wrap:anywhere]">{t(tag.name)}</Badge>)}
                        </div>
                        {hiddenTagCount > 0 ? (
                          <Button size="sm" variant="ghost" className="px-0 text-primary" aria-expanded={expandedTags} aria-controls="game-tag-preview" onClick={() => setExpandedTags(value => !value)}>
                            {expandedTags ? "收起标签" : `另有 ${hiddenTagCount} 个标签`}
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                )}
              </CardContent>
            </Card>
            {game.notes && !editingInfo ? <Card>
              <CardHeader><CardTitle>备注</CardTitle></CardHeader>
              <CardContent><p className="whitespace-pre-wrap break-words text-sm leading-6">{game.notes}</p></CardContent>
            </Card> : null}
            <BangumiSyncProfilePanel key={game.id} gameId={game.id} />
          </>
        ) : null}

        {tab === "guide" ? (
          <>
            <GuidePanel
              key={`guide:${game.id}`}
              gameId={game.id}
              twodfanId={game.twodfanId}
              onBindSubject={subjectId => { void bindTwodfanSubject(subjectId); }}
              onOpenUrl={openExternal}
            />
            <RelationsPanel
              key={`relations:${game.id}:${game.vndbId ?? ""}`}
              vndbId={game.vndbId}
              onOpenUrl={openExternal}
              onOpenGame={id => navigate(`/library/${id}`)}
            />
          </>
        ) : null}

        {tab === "files" ? (
          <>
            <Card>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
                <CardTitle>路径与启动</CardTitle>
                <Button size="sm" variant="outline" onClick={() => void openInstallFolder()}>打开安装目录</Button>
              </CardHeader>
              <CardContent className="space-y-4">
                <fieldset disabled={saving} className="min-w-0 space-y-3">
                  <Field label="启动文件">
                    <PathInput label="可执行文件" kind="file" value={form.exePath} disabled={saving || choosingLauncher}
                      onChange={value => setForm(before => before ? { ...before, exePath: value } : before)} />
                  </Field>
                  <Field label="安装路径">
                    <PathInput label="安装路径" kind="directory" value={form.installPath} disabled={saving}
                      onChange={value => setForm(before => before ? { ...before, installPath: value } : before)} />
                  </Field>
                  {isScriptPath(form.exePath) ? (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      当前使用 .bat/.cmd 启动脚本，恋页会跟踪脚本启动的游戏进程。需要转区时，请选择游戏 exe。
                    </p>
                  ) : null}
                  <Field label="存档路径">
                    <PathInput label="存档路径" kind="either" value={form.savePath} disabled={saving}
                      onChange={value => setForm(before => before ? { ...before, savePath: value } : before)} />
                  </Field>
                  <details className="rounded-lg border border-border">
                    <summary className="cursor-pointer rounded-lg px-3 py-2.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">高级启动设置</summary>
                    <div className="space-y-3 border-t border-border p-3">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="启动参数"><Input value={form.launchArgs} onChange={event => setForm({ ...form, launchArgs: event.target.value })} /></Field>
                        <Field label="工作目录" hint="留空时使用可执行文件所在目录">
                          <PathInput label="工作目录" kind="directory" value={form.workdir} disabled={saving}
                            onChange={value => setForm(before => before ? { ...before, workdir: value } : before)} />
                        </Field>
                      </div>
                      <LaunchProfilePanel gameId={gameId} />
                    </div>
                  </details>
                </fieldset>
                {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
                {sectionActions("files", "保存路径")}
              </CardContent>
            </Card>
            <ArchivePanel key={game.id} gameId={game.id} />
          </>
        ) : null}

        {tab === 'saves' ? <Card><CardHeader><CardTitle>游戏存档备份</CardTitle></CardHeader><CardContent>
          <SaveBackupPanel gameId={game.id} savePath={game.savePath} onPathSaved={path => {
            setGame(current => current?.id === game.id ? { ...current, savePath: path } : current);
            if (formBaseline.current) formBaseline.current = { ...formBaseline.current, savePath: path };
            setForm(current => current ? { ...current, savePath: path } : current);
          }} />
        </CardContent></Card> : null}

        {tab === "tags" ? (
          <Card>
            <CardHeader>
              <CardTitle>标签</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">
                点击标签，前往左侧「标签管理」中的对应位置，查看使用该标签的作品。
              </p>
              <div className="flex flex-wrap gap-2">
                {tags.map(tag => (
                  <Link
                    key={tag.id}
                    to={`/tags?tagId=${tag.id}`}
                    title={`前往标签管理中的「${t(tag.name)}」`}
                    className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Badge color={tag.color} variant="outline" className="px-3 py-1.5 hover:bg-accent">
                      <span title={tag.name}>{t(tag.name)}</span>
                    </Badge>
                  </Link>
                ))}
                {tags.length === 0 ? <p className="text-xs text-muted-foreground">这个游戏还没有标签。</p> : null}
              </div>
              <fieldset disabled={saving} className="flex min-w-0 flex-col gap-3 rounded-md border border-border p-3">
                <legend className="px-1 text-sm font-medium">添加标签</legend>
                <form
                  className="flex flex-wrap items-end gap-2"
                  onSubmit={event => { event.preventDefault(); addTag(); }}
                >
                  <Field label="标签名称" className="min-w-40 flex-1">
                    <Input
                      value={newTagName}
                      onChange={event => { setNewTagName(event.target.value); setTagError(null); }}
                      onKeyDown={event => {
                        if (event.key === "Enter" && event.nativeEvent.isComposing) event.preventDefault();
                      }}
                      placeholder="输入新标签或已有标签的名称"
                      aria-invalid={tagError ? true : undefined}
                      aria-describedby={tagError ? "game-tag-error" : undefined}
                    />
                  </Field>
                  <Button type="submit" disabled={!newTagName.trim()}>添加标签</Button>
                </form>
                {tagError ? <p id="game-tag-error" role="alert" className="text-xs text-destructive">{tagError}</p> : null}
                {pendingTagNames.length > 0 ? (
                  <div className="flex flex-wrap gap-2" aria-label="待保存的新标签">
                    {pendingTagNames.map(name => (
                      <Badge key={name} variant="outline" className="gap-2 px-2.5 py-1">
                        {name}<span className="text-muted-foreground">未保存</span>
                        <button
                          type="button"
                          aria-label={`移除待保存标签「${name}」`}
                          className="rounded px-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={() => setPendingTagNames(current => current.filter(item => item !== name))}
                        >×</button>
                      </Badge>
                    ))}
                  </div>
                ) : null}
                <div className="flex flex-col gap-2">
                  <details className="group rounded-md border border-border" data-tag-picker>
                    <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 rounded-md px-3 py-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                      <span className="font-medium">可选标签</span>
                      <span className="text-muted-foreground">
                        共 {allTags.length} 个 · 已选 {allTags.filter(tag => selectedTagIds.includes(tag.id)).length} 个
                      </span>
                      <span className="ml-auto inline-flex items-center gap-1 text-muted-foreground">
                        <span className="group-open:hidden">展开</span>
                        <span className="hidden group-open:inline">收起</span>
                        <svg aria-hidden="true" viewBox="0 0 16 16" fill="none" className="size-3 transition-transform group-open:rotate-180 motion-reduce:transition-none">
                          <path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    </summary>
                    <div className="flex flex-col gap-2 border-t border-border px-3 py-3">
                      <p className="text-xs text-muted-foreground">点击标签添加或移除</p>
                      <TagSelector
                        allTags={allTags.map(tag => ({ ...tag, name: t(tag.name) }))}
                        selectedIds={selectedTagIds}
                        onChange={setSelectedTagIds}
                        emptyHint="还没有已有标签，可在上方输入名称添加。"
                      />
                    </div>
                  </details>

                </div>
              </fieldset>
              {sectionActions("tags", "保存标签")}
            </CardContent>
          </Card>
        ) : null}

        {tab === "history" ? (
          <PlayHistoryPanel game={game} sessions={sessions} />
        ) : null}
        </div>
      </div>

      </div>

      <ConfirmDialog
        open={confirmDelete}
        destructive
        busy={deleting}
        title="删除这个游戏？"
        description={`「${game.title}」的记录、标签关联与游玩历史都会被删除，此操作不可撤销。`}
        confirmText="删除"
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />

      <ConfirmDialog
        open={confirmMetadata}
        title="有未保存的修改"
        description="应用元数据后会重新载入本页，表单里未保存的修改会丢失。要先放弃它们吗？"
        confirmText="放弃并继续"
        onConfirm={() => {
          setConfirmMetadata(false);
          setMetadataOpen(true);
        }}
        onCancel={() => setConfirmMetadata(false)}
      />

      <MetadataDialog
        open={metadataOpen}
        gameId={gameId}
        // The persisted path, not the (possibly unsaved) form value: the cover
        // must land in the directory the database actually points at.
        installPath={game.installPath}
        initialQuery={game.title}
        onClose={closeMetadata}
        onApplied={() => setMetadataDirty(true)}
      />
      {launcher.dialogGame ? <LaunchDialog
        open
        game={launcher.dialogGame}
        onClose={launcher.closeDialog}
        // Silent refresh: a full `load()` would flip `loading` and unmount this
        // very dialog the moment the game starts.
        onLaunched={() => void refreshQuietly()}
      /> : null}
    </div>
  );
}
