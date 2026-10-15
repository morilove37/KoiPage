import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { CoverImage } from "@/components/ui/cover-image";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs } from "@/components/ui/tabs";
import LaunchDialog from "@/features/launch/LaunchDialog";
import MetadataDialog from "@/features/metadata/MetadataDialog";
import type { GameExitedPayload } from "@/features/io/io";
import {
  gameDelete,
  gameGet,
  gameUpdate,
  playSessionsList,
  tagsList,
} from "@/lib/db";
import { useAppStore } from "@/store/app";
import { useLocalizedTags } from "@/lib/localization";
import { formatRating, roundRating } from "@/lib/rating";
import { isGameOpeningTransition } from "@/lib/game-opening";
import {
  GAME_STATUSES,
  GAME_STATUS_LABELS,
  formatPlayTime,
  isFavorite,
} from "@/types/game";
import type { GameDetail, GamePatch, GameStatus, PlaySession, Tag } from "@/types/game";

import { TagSelector } from "./TagSelector";
import PlayHistoryPanel from "./PlayHistoryPanel";

/** Form state: every field is a string so inputs stay controlled and empty-able. */
interface FormState {
  title: string;
  originalTitle: string;
  developer: string;
  releaseDate: string;
  status: GameStatus;
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
  bangumiId: string;
}

function toForm(game: GameDetail): FormState {
  return {
    title: game.title,
    originalTitle: game.originalTitle ?? "",
    developer: game.developer ?? "",
    releaseDate: game.releaseDate ?? "",
    status: game.status,
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
    bangumiId: game.bangumiId ?? "",
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

export default function GameDetailPage() {
  const sharedOpening = useRef<boolean | null>(null);
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const gameId = Number(id);
  const playTimeRevision = useAppStore((s) => s.playTimeRevision);

  const [game, setGame] = useState<GameDetail | null>(null);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [sessions, setSessions] = useState<PlaySession[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [selectedTagIds, setSelectedTagIds] = useState<number[]>([]);
  const [newTagName, setNewTagName] = useState("");
  const [pendingTagNames, setPendingTagNames] = useState<string[]>([]);
  const [tagError, setTagError] = useState<string | null>(null);
  const [tab, setTab] = useState("info");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const requested = searchParams.get("tab");
    setTab(requested && ["info", "files", "tags", "history"].includes(requested) ? requested : "info");
    contentRef.current?.scrollTo({ top: 0, behavior: "instant" });
  }, [searchParams]);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false);
  /** Set once metadata was written, so closing the dialog triggers one reload. */
  const [metadataDirty, setMetadataDirty] = useState(false);
  const [confirmMetadata, setConfirmMetadata] = useState(false);
  const [launchOpen, setLaunchOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
      setForm(toForm(detail));
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
  }, [load, playTimeRevision]);

  /** Back out of the detail view, preferring the real previous page. */
  const goBack = useCallback(() => {
    // The decision is frozen at mount (`canGoBackRef`) so entries pushed *after*
    // this page opened — a tag link to /tags, say — cannot redirect 返回 to a
    // sibling page instead of the library the user came from.
    if (canGoBackRef.current) navigate(-1);
    else navigate("/library");
  }, [navigate]);

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
    if (!game || !form) return null;
    const patch: GamePatch = {};

    if (form.title.trim() !== game.title) patch.title = form.title.trim();
    if (form.installPath.trim() !== game.installPath)
      patch.installPath = form.installPath.trim();
    if (orNull(form.originalTitle) !== game.originalTitle)
      patch.originalTitle = orNull(form.originalTitle);
    if (orNull(form.developer) !== game.developer)
      patch.developer = orNull(form.developer);
    if (orNull(form.releaseDate) !== game.releaseDate)
      patch.releaseDate = orNull(form.releaseDate);
    if (form.status !== game.status) patch.status = form.status;
    if (form.coverPath.trim() !== (game.coverPath ?? ""))
      patch.coverPath = orNull(form.coverPath);
    if (form.description.trim() !== (game.description ?? ""))
      patch.description = orNull(form.description);
    if (form.exePath.trim() !== (game.exePath ?? ""))
      patch.exePath = orNull(form.exePath);
    if (form.launchArgs.trim() !== (game.launchArgs ?? ""))
      patch.launchArgs = orNull(form.launchArgs);
    if (form.workdir.trim() !== (game.workdir ?? ""))
      patch.workdir = orNull(form.workdir);
    if (form.savePath.trim() !== (game.savePath ?? ""))
      patch.savePath = orNull(form.savePath);
    if (form.notes.trim() !== (game.notes ?? ""))
      patch.notes = orNull(form.notes);
    if (form.vndbId.trim() !== (game.vndbId ?? ""))
      patch.vndbId = orNull(form.vndbId);
    if (form.bangumiId.trim() !== (game.bangumiId ?? ""))
      patch.bangumiId = orNull(form.bangumiId);

    const ratingRaw = form.rating.trim();
    const rating = ratingRaw === "" ? null : roundRating(Number(ratingRaw));
    if (rating !== game.rating) patch.rating = rating;

    const currentTags = [...game.tags].sort((a, b) => a - b);
    const nextTags = [...selectedTagIds].sort((a, b) => a - b);
    if (currentTags.join(",") !== nextTags.join(",")) patch.tags = nextTags;
    if (pendingTagNames.length > 0) patch.tagNames = pendingTagNames;

    return patch;
  };

  const save = async () => {
    if (!form || saving) return;
    if (form.title.trim() === "") {
      setError("标题不能为空。");
      return;
    }
    if (form.installPath.trim() === "") {
      setError("安装路径不能为空。");
      return;
    }
    const ratingRaw = form.rating.trim();
    if (ratingRaw !== "") {
      const rating = Number(ratingRaw);
      if (!Number.isFinite(rating) || rating < 0 || rating > 10) {
        setError("评分必须是 0-10 的数字，支持小数。");
        return;
      }
    }

    const patch = buildPatch();
    if (!patch || Object.keys(patch).length === 0) {
      setNotice("没有需要保存的修改。");
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await gameUpdate(gameId, patch);
      setNotice("已保存。");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const toggleFavorite = async () => {
    if (!game) return;
    const next = isFavorite(game) ? 0 : 1;
    setGame({ ...game, favorite: next });
    try {
      await gameUpdate(gameId, { favorite: next });
    } catch (cause) {
      setGame({ ...game, favorite: game.favorite });
      setError(cause instanceof Error ? cause.message : String(cause));
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
    setNotice("已更新资料。");
    void load();
  };

  if (loading) {
    return (
      <div className="flex flex-col items-start gap-3 p-5" data-detail-state="loading" data-game-id={gameId}>
        <Button variant="outline" size="sm" onClick={goBack} title="返回上一页">
          <span aria-hidden>←</span>
          返回
        </Button>
        <div className="text-sm text-muted-foreground">载入中…</div>
      </div>
    );
  }

  if (!game || !form) {
    return (
      <div className="flex flex-col items-start gap-3 p-5" data-detail-state="error" data-game-id={gameId}>
        <Button variant="outline" size="sm" onClick={goBack} title="返回上一页">
          <span aria-hidden>←</span>
          返回
        </Button>
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
  const tags = selectedTagIds
    .map((tagId) => tagById.get(tagId))
    .filter((tag): tag is Tag => tag !== undefined);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-5" data-game-detail data-game-id={game.id}>
      {/* Header ---------------------------------------------------------- */}
      <div className="flex shrink-0 flex-col gap-2" data-detail-header>
        <div className="flex items-center justify-between gap-3" data-detail-toolbar>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={goBack}
              title="返回上一页"
              aria-label="返回"
            >
              <span aria-hidden>←</span>
              返回
            </Button>
            <Link
              to="/library"
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              游戏库
            </Link>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <Button
              onClick={() => setLaunchOpen(true)}
              title={
                game.exePath?.trim()
                  ? "启动这个游戏"
                  : "还没有设置 exe 路径，点开可以查看详情"
              }
            >
              启动游戏
            </Button>
            <Button
              variant="outline"
              onClick={openMetadata}
              title="从鲲 Galgame 论坛 / VNDB / Bangumi 联网获取资料"
            >
              联网获取资料
            </Button>
            <Button
              variant={favorite ? "default" : "outline"}
              onClick={() => void toggleFavorite()}
            >
              {favorite ? "★ 已收藏" : "☆ 收藏"}
            </Button>
            <Button variant="outline" loading={saving} onClick={() => void save()}>
              保存
            </Button>
            <Button variant="destructive" onClick={() => setConfirmDelete(true)}>
              删除
            </Button>
          </div>
        </div>
        <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight" title={game.title}>
          {game.title}
        </h1>
      </div>

      <div ref={contentRef} className={`flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto${sharedOpening.current ? "" : " detail-content-enter"}`} data-detail-scroll>
      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-border bg-accent px-3 py-2 text-xs">
          {notice}
        </div>
      ) : null}

      <Tabs
        className="shrink-0"
        value={tab}
        onValueChange={value => {
          setTab(value);
          contentRef.current?.scrollTo({ top: 0, behavior: "instant" });
        }}
        items={[
          { value: "info", label: "基本信息" },
          { value: "files", label: "路径与启动" },
          { value: "tags", label: "标签" },
          { value: "history", label: "游玩历史" },
        ]}
      />

      <div className="grid items-start gap-3 grid-cols-[112px_minmax(0,1fr)] md:grid-cols-[160px_minmax(0,1fr)] lg:grid-cols-[200px_minmax(0,1fr)]">
        {/* Cover --------------------------------------------------------- */}
        <Card className="h-fit min-w-0">
          <CardContent className="p-3">
            <div data-detail-cover className="aspect-[3/4] w-full overflow-hidden rounded bg-muted">
              <CoverImage
                loading="eager"
                path={game.coverPath}
                alt={game.title}
                className="h-full w-full object-cover"
              />
            </div>
            <dl className="mt-3 grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-x-2 gap-y-2 text-xs">
              <dt className="text-muted-foreground">评分</dt>
              <dd className="min-w-0 break-words text-right font-semibold tabular-nums text-primary">{form.rating === "" ? "未评分" : formatRating(Number(form.rating))}</dd>
              <dt className="text-muted-foreground">发售日</dt>
              <dd className="min-w-0 break-words text-right">{form.releaseDate || "未填写"}</dd>
              <dt className="text-muted-foreground">开发商</dt>
              <dd className="min-w-0 break-words text-right">{form.developer || "未填写"}</dd>
              <dt className="text-muted-foreground">原名</dt>
              <dd className="min-w-0 break-words text-right">{form.originalTitle || "未填写"}</dd>
              <dt className="text-muted-foreground">状态</dt>
              <dd className="min-w-0 text-right">{GAME_STATUS_LABELS[form.status]}</dd>
            </dl>
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-primary">编辑资料</summary>
              <div className="mt-2 flex flex-col gap-2">
                <Field label="评分" hint="0-10，支持小数，留空表示未评分">
                  <Input
                    type="number"
                    min={0}
                    max={10}
                    step="0.01"
                    value={form.rating}
                    onChange={event => setForm({ ...form, rating: event.target.value })}
                    placeholder="留空"
                  />
                </Field>
                <Field label="发售日" hint="通常是 YYYY-MM-DD">
                  <Input value={form.releaseDate} onChange={event => setForm({ ...form, releaseDate: event.target.value })} />
                </Field>
                <Field label="开发商">
                  <Input value={form.developer} onChange={event => setForm({ ...form, developer: event.target.value })} />
                </Field>
                <Field label="原名">
                  <Input value={form.originalTitle} onChange={event => setForm({ ...form, originalTitle: event.target.value })} />
                </Field>
                <Field label="状态">
                  <Select
                    value={form.status}
                    onValueChange={value => setForm({ ...form, status: value as GameStatus })}
                    options={GAME_STATUSES.map(status => ({ value: status, label: GAME_STATUS_LABELS[status] }))}
                  />
                </Field>
                <p className="text-muted-foreground">修改后点击右上角「保存」生效。</p>
              </div>
            </details>
            <dl className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs">
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">游玩时长</dt>
                <dd>{formatPlayTime(game.playTimeSeconds)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">最近游玩</dt>
                <dd className="text-right">{formatDateTime(game.lastPlayedAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">创建于</dt>
                <dd className="text-right">{formatDateTime(game.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">更新于</dt>
                <dd className="text-right">{formatDateTime(game.updatedAt)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        {/* Panels -------------------------------------------------------- */}
        {tab === "info" ? (
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle>基本信息</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="简介" className="sm:col-span-2">
                <div id="game-description" className="flex flex-col gap-2">
                  <Textarea
                    aria-label="简介"
                    className="min-h-40"
                    value={form.description}
                    onChange={event => setForm({ ...form, description: event.target.value })}
                    placeholder="暂无简介，可在此填写或联网获取资料。"
                  />
                </div>
              </Field>
              <Field label="标题" className="sm:col-span-2">
                <Input
                  value={form.title}
                  onChange={(event) =>
                    setForm({ ...form, title: event.target.value })
                  }
                />
              </Field>
              <Field label="封面路径">
                <Input
                  value={form.coverPath}
                  onChange={(event) =>
                    setForm({ ...form, coverPath: event.target.value })
                  }
                  placeholder="本地绝对路径"
                />
              </Field>
              <Field label="VNDB ID">
                <Input
                  value={form.vndbId}
                  onChange={(event) =>
                    setForm({ ...form, vndbId: event.target.value })
                  }
                />
              </Field>
              <Field label="Bangumi ID">
                <Input
                  value={form.bangumiId}
                  onChange={(event) =>
                    setForm({ ...form, bangumiId: event.target.value })
                  }
                />
              </Field>
              <Field label="备注" className="sm:col-span-2">
                <Textarea
                  value={form.notes}
                  onChange={(event) =>
                    setForm({ ...form, notes: event.target.value })
                  }
                />
              </Field>
            </CardContent>
          </Card>
        ) : null}

        {tab === "files" ? (
          <Card>
            <CardHeader>
              <CardTitle>路径与启动</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <Field label="安装路径" className="sm:col-span-2">
                <Input
                  value={form.installPath}
                  onChange={(event) =>
                    setForm({ ...form, installPath: event.target.value })
                  }
                />
              </Field>
              <Field label="可执行文件" className="sm:col-span-2">
                <Input
                  value={form.exePath}
                  onChange={(event) =>
                    setForm({ ...form, exePath: event.target.value })
                  }
                />
              </Field>
              <Field label="启动参数">
                <Input
                  value={form.launchArgs}
                  onChange={(event) =>
                    setForm({ ...form, launchArgs: event.target.value })
                  }
                />
              </Field>
              <Field label="工作目录">
                <Input
                  value={form.workdir}
                  onChange={(event) =>
                    setForm({ ...form, workdir: event.target.value })
                  }
                />
              </Field>
              <Field label="存档路径" className="sm:col-span-2">
                <Input
                  value={form.savePath}
                  onChange={(event) =>
                    setForm({ ...form, savePath: event.target.value })
                  }
                />
              </Field>
            </CardContent>
          </Card>
        ) : null}

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
                  <p className="text-xs text-muted-foreground">
                    添加或移除标签后，点击右上角「保存」生效。
                  </p>
                </div>
              </fieldset>
            </CardContent>
          </Card>
        ) : null}

        {tab === "history" ? (
          <PlayHistoryPanel game={game} sessions={sessions} />
        ) : null}
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
      <LaunchDialog
        open={launchOpen}
        game={game}
        onClose={() => setLaunchOpen(false)}
        // Silent refresh: a full `load()` would flip `loading` and unmount this
        // very dialog the moment the game starts.
        onLaunched={() => void refreshQuietly()}
      />
    </div>
  );
}
