/**
 * "联网获取资料" — external metadata lookup and application.
 *
 * Flow: type a title → tick the sources to query → pick one candidate → review
 * the merged detail → tick the fields to write → apply. Covers are handled
 * separately from the text fields because `metadata_apply` only knows about
 * columns: the cover is downloaded by `metadata_cover_cache` into managed
 * directory and then stored with `game_update`.
 *
 * Two things this dialog must never hide:
 *
 * 1. `metadata_search` reports per-provider failures in `errors`. VNDB allows
 *    200 requests / 5 minutes and Bangumi occasionally returns 5xx, so an empty
 *    result list usually means "one source is rate-limited", not "no such game".
 * 2. `attribution` is the credit NextMoe's terms require for its Galgame data
 *    ("鲲 Galgame 论坛"); it is rendered whenever a detail is on screen.
 *
 * Nothing is written before the user confirms, and only the ticked fields are
 * sent — upstream data is frequently attached to the wrong work.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CoverImage } from "@/components/ui/cover-image";
import { EmptyState } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  gameUpdate,
  metadataApply,
  metadataCoverCache,
  metadataDetail,
  metadataSearch,
  settingsGet,
} from "@/lib/db";
import type {
  Game,
  GameInput,
  MetadataCandidate,
  MetadataDetail,
  MetadataField,
  MetadataProvider,
  MetadataSearchResult,
  MetadataTagMode,
} from "@/lib/db";
import { cn } from "@/lib/utils";
import { useLocalizedTags } from "@/lib/localization";

import {
  ALL_PROVIDERS,
  FIELD_LABELS,
  FIELD_NOTES,
  FIELD_ORDER,
  PROVIDER_LABELS,
  TITLE_LANGUAGE_KEY,
  defaultChecked,
  errorMessage,
  fieldPreview,
  formatScore,
  formatSourceRating,
  hasFieldData,
  normalizeTitlePreference,
  providerLabel,
  titleFor,
  type MetadataTitlePreference,
} from "./fields";
import { ManualEntryForm } from "./ManualEntryForm";
import { ImportWaitDialog } from "./ImportWaitDialog";
import { createGameFromMetadata } from "./create-game";
import { DEFAULT_SOURCE_KEY, ENABLED_SOURCES_KEY, normalizeDefaultSource, normalizeEnabledSources } from "./preferences";

export interface MetadataDialogProps {
  open: boolean;
  gameId?: number;
  /** Import draft: saved only when the user confirms the work or manual form. */
  draft?: GameInput;
  onCreated?: (game: Game) => void;
  onCancelBatch?: () => void;
  progressLabel?: string;
  /** Installation path retained for import compatibility; covers use app storage. */
  installPath: string;
  /** Pre-fills the search box, typically the game's current title. */
  initialQuery?: string;
  /** Start the multi-provider search as soon as the dialog opens. */
  autoSearchOnOpen?: boolean;
  initialMode?: "search" | "manual";
  onClose: () => void;
  /** Fired after any successful write, so the host can reload its copy. */
  onApplied?: () => void;
}

const TAG_MODE_OPTIONS: ReadonlyArray<{ value: MetadataTagMode; label: string }> = [
  { value: "merge", label: "合并到现有标签（推荐）" },
  { value: "replace", label: "替换现有标签" },
];

/** Result panel shown once a write has happened. */
interface ApplyOutcome {
  /** Fields the command actually wrote (may be 0 even when fields were ticked). */
  fieldsApplied: number;
  /** Fields the user had ticked, for the "upstream had no values" message. */
  fieldsRequested: number;
  tagsAdded: number;
  coverPath: string | null;
  coverError: string | null;
}

export default function MetadataDialog({
  open,
  gameId,
  draft,
  onCreated,
  onCancelBatch,
  progressLabel,
  installPath,
  initialQuery,
  autoSearchOnOpen = false,
  initialMode = "search",
  onClose,
  onApplied,
}: MetadataDialogProps) {
  const [mode, setMode] = useState<"search" | "manual">("search");

  // --- search step ---------------------------------------------------------
  const [query, setQuery] = useState("");
  const [searchedTitle, setSearchedTitle] = useState("");
  const [sources, setSources] = useState<MetadataProvider[]>([...ALL_PROVIDERS]);
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<MetadataSearchResult | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  // --- detail step ---------------------------------------------------------
  const [selected, setSelected] = useState<MetadataCandidate | null>(null);
  const [detail, setDetail] = useState<MetadataDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // --- confirmation step ---------------------------------------------------
  const [checked, setChecked] = useState<Record<MetadataField, boolean> | null>(null);
  const [coverChecked, setCoverChecked] = useState(false);
  const [tagMode, setTagMode] = useState<MetadataTagMode>("merge");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ApplyOutcome | null>(null);
  const [manualSaving, setManualSaving] = useState(false);
  const [waitNoticeOpen, setWaitNoticeOpen] = useState(false);
  const busy = searching || detailLoading || applying || manualSaving;

  useEffect(() => {
    if (!open || !busy) setWaitNoticeOpen(false);
  }, [open, busy]);
  // Use the same title-language preference for confirmation and auto-fetch.
  const [titlePreference, setTitlePreference] = useState<MetadataTitlePreference>("zh");
  const [defaultSource, setDefaultSource] = useState<MetadataProvider>("vndb");
  const [enabledSources, setEnabledSources] = useState<MetadataProvider[]>([]);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const orderedProviders = useMemo(() => enabledSources.includes(defaultSource)
    ? [defaultSource, ...enabledSources.filter(provider => provider !== defaultSource)] : enabledSources, [defaultSource, enabledSources]);

  useEffect(() => {
    if (!open) return;
    setPreferencesReady(false);
    setEnabledSources([]);
    let cancelled = false;
    void Promise.all([settingsGet(TITLE_LANGUAGE_KEY), settingsGet(DEFAULT_SOURCE_KEY), settingsGet(ENABLED_SOURCES_KEY)])
      .then(([value, source, enabled]) => {
        if (!cancelled) {
          const providers = normalizeEnabledSources(enabled);
          setTitlePreference(normalizeTitlePreference(value));
          setDefaultSource(normalizeDefaultSource(source, providers));
          setEnabledSources(providers);
          setSources(providers);
          setPreferencesReady(providers.length > 0);
          if (!providers.length) {
            setSearching(false);
            setSearchError('没有启用的数据源，请先在设置中勾选搜索数据源。');
          }
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setSearching(false);
          setSearchError(`读取搜索数据源设置失败：${errorMessage(cause)}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, gameId, initialQuery, autoSearchOnOpen, initialMode, draft?.installPath]);
  const { t, enabled: localizationEnabled } = useLocalizedTags();
  // Use the submitted query that produced these candidates. Editing the input
  // without searching again must not attach an unrelated name to stale results.
  const searchName = searchedTitle || query.trim() || draft?.title.trim() || initialQuery?.trim() || "";
  const importDraft = useMemo(() => draft ? { ...draft, title: searchName } : undefined, [draft, searchName]);
  const detailForWrite = useMemo(() => {
    if (!detail) return null;
    // The query is only a lookup key, regardless of its script. With the default
    // Chinese preference, a known Chinese title also replaces Japanese folders.
    const title = titleFor(detail, titlePreference) || searchName;
    return { ...detail, title, titleZh: null };
  }, [detail, searchName, titlePreference]);
  const displayDetail = useMemo(() => detailForWrite ? {
    ...detailForWrite, tags: detailForWrite.tags.map(t),
  } : null, [detailForWrite, t]);

  // The component stays mounted while `open` is false (the host always renders
  // it), so async work is guarded by both a liveness flag and a request token.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const detailSeq = useRef(0);
  const searchSeq = useRef(0);
  const autoSearchKeyRef = useRef("");

  // Reset on every open so a previous lookup never leaks into the next one.
  useEffect(() => {
    if (!open) return;
    detailSeq.current += 1; // invalidate any in-flight detail request
    setMode(initialMode);
    setQuery(initialQuery?.trim() ?? "");
    setSearchedTitle("");
    setSources([]);
    setSearching(autoSearchOnOpen);
    setResult(null);
    setSearchError(null);
    setSelected(null);
    setDetail(null);
    setDetailLoading(false);
    setDetailError(null);
    setChecked(null);
    setCoverChecked(false);
    setTagMode("merge");
    setApplying(false);
    setApplyError(null);
    setOutcome(null);
    return () => { searchSeq.current += 1; detailSeq.current += 1; };
  }, [open, gameId, initialQuery, autoSearchOnOpen, initialMode, draft?.installPath]);

  const performSearch = useCallback(async (
    rawQuery: string,
    selectedSources: MetadataProvider[],
  ) => {
    const trimmed = rawQuery.trim();
    if (trimmed === "") {
      setSearchError("请输入要搜索的作品名。");
      return;
    }
    if (selectedSources.length === 0) {
      setSearchError("请至少勾选一个数据源。");
      return;
    }

    setSearching(true);
    setSearchedTitle(trimmed);
    setSearchError(null);
    setResult(null);
    setSelected(null);
    setDetail(null);
    setDetailLoading(false); // This search supersedes any pending detail lookup.
    setDetailError(null);
    setChecked(null);
    setCoverChecked(false);
    setApplyError(null);
    setOutcome(null);
    detailSeq.current += 1;

    const seq = ++searchSeq.current;
    try {
      const found = await metadataSearch(trimmed, selectedSources);
      if (!aliveRef.current || seq !== searchSeq.current) return;
      setResult(found);
      // Only an actual empty result is "not found". Provider failures stay
      // visible with retry and manual entry available.
      if (found.candidates.length === 0 && found.errors.length === 0) {
        setMode("manual");
      }
    } catch (cause) {
      if (!aliveRef.current || seq !== searchSeq.current) return;
      setSearchError(errorMessage(cause));
    } finally {
      if (aliveRef.current && seq === searchSeq.current) setSearching(false);
    }
  }, []);

  const runSearch = useCallback(
    () => preferencesReady ? performSearch(query, sources.filter(provider => enabledSources.includes(provider))) : Promise.resolve(),
    [performSearch, query, sources, preferencesReady, enabledSources],
  );

  useEffect(() => {
    if (!open) { autoSearchKeyRef.current = ""; return; }
    if (!autoSearchOnOpen || !preferencesReady) return;
    const initial = initialQuery?.trim() ?? "";
    if (initial === "") return;
    const key = `${gameId ?? draft?.installPath}\n${initial}`;
    if (autoSearchKeyRef.current === key) return;
    // Defer one tick so React's development effect replay cannot issue a
    // duplicate network search or reset a live request.
    const timer = window.setTimeout(() => {
      autoSearchKeyRef.current = key;
      void performSearch(initial, enabledSources);
    }, 0);
    return () => { window.clearTimeout(timer); };
  }, [open, gameId, draft?.installPath, initialQuery, autoSearchOnOpen, performSearch, preferencesReady, enabledSources]);

  const choose = useCallback(async (candidate: MetadataCandidate) => {
    const seq = detailSeq.current + 1;
    detailSeq.current = seq;
    setSelected(candidate);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    setChecked(null);
    setCoverChecked(false);
    setTagMode("merge");
    setApplyError(null);
    setOutcome(null);

    try {
      const found = await metadataDetail(candidate.provider, candidate.externalId);
      if (!aliveRef.current || seq !== detailSeq.current) return;
      setDetail(found);
      setChecked(defaultChecked({ ...found, title: searchedTitle, titleZh: null }));
      // Only offer the cover when there is something to download.
      setCoverChecked(found.coverUrl !== null && found.coverUrl.trim() !== "");
    } catch (cause) {
      if (!aliveRef.current || seq !== detailSeq.current) return;
      setDetailError(errorMessage(cause));
    } finally {
      if (aliveRef.current && seq === detailSeq.current) setDetailLoading(false);
    }
  }, [searchedTitle]);

  const selectedFields = useMemo(() => {
    if (!detailForWrite || !checked) return [] as MetadataField[];
    return FIELD_ORDER.filter((field) => checked[field] && hasFieldData(detailForWrite, field));
  }, [detailForWrite, checked]);

  const wantsCover =
    detail !== null && coverChecked && detail.coverUrl !== null && detail.coverUrl !== "";

  const apply = useCallback(async () => {
    if (!detail || !detailForWrite) return;
    if (selectedFields.length === 0 && !wantsCover) {
      setApplyError("请至少勾选一个要写入的字段（或封面）。");
      return;
    }

    setApplying(true);
    setApplyError(null);
    setOutcome(null);

    try {
      if (importDraft) {
        // New imports must carry the title resolved above; `metadataInput` reads
        // the draft title, so hand it the resolved name instead of the raw query.
        const draftForCreate = { ...importDraft, title: detailForWrite.title.trim() || importDraft.title };
        const { game } = await createGameFromMetadata(draftForCreate, detailForWrite, selectedFields, wantsCover);
        onCreated?.(game);
        return;
      }
      if (gameId === undefined) throw new Error("缺少游戏记录。");
      let fieldsApplied = 0;
      let tagsAdded = 0;
      if (selectedFields.length > 0) {
        const applied = await metadataApply(gameId, detailForWrite, selectedFields, tagMode);
        fieldsApplied = applied.fieldsApplied;
        tagsAdded = applied.tagsAdded;
      }

      // The cover is best-effort: the text fields are already committed, so a
      // failed download degrades to a warning instead of an error.
      let coverPath: string | null = null;
      let coverError: string | null = null;
      if (wantsCover && detail.coverUrl) {
        try {
          const localPath = await metadataCoverCache(gameId, detail.coverUrl, installPath.trim());
          await gameUpdate(gameId, { coverPath: localPath });
          coverPath = localPath;
        } catch (cause) {
          coverError = errorMessage(cause);
        }
      }

      if (!aliveRef.current) return;
      setOutcome({
        fieldsApplied,
        fieldsRequested: selectedFields.length,
        tagsAdded,
        coverPath,
        coverError,
      });
      onApplied?.();
    } catch (cause) {
      if (!aliveRef.current) return;
      setApplyError(errorMessage(cause));
    } finally {
      if (aliveRef.current) setApplying(false);
    }
  }, [detail, detailForWrite, selectedFields, wantsCover, tagMode, gameId, installPath, onApplied, importDraft, onCreated]);

  /** Fallback when the cover cannot be cached: keep the remote URL instead. */
  const useRemoteCover = useCallback(async () => {
    const remoteUrl = detail?.coverUrl;
    if (!remoteUrl || gameId === undefined) return;
    setApplyError(null);
    try {
      await gameUpdate(gameId, { coverPath: remoteUrl });
      if (!aliveRef.current) return;
      setOutcome((previous) =>
        previous === null ? previous : { ...previous, coverPath: remoteUrl, coverError: null },
      );
      onApplied?.();
    } catch (cause) {
      if (!aliveRef.current) return;
      setApplyError(errorMessage(cause));
    }
  }, [detail, gameId, onApplied]);

  const toggleField = useCallback((field: MetadataField, value: boolean) => {
    setChecked((previous) => (previous === null ? previous : { ...previous, [field]: value }));
  }, []);

  const toggleSource = useCallback((provider: MetadataProvider, value: boolean) => {
    setSources((previous) =>
      value ? [...previous, provider] : previous.filter((item) => item !== provider),
    );
  }, []);

  const selectAllFields = useCallback(
    (value: boolean) => {
      if (!detailForWrite) return;
      setChecked((previous) => {
        if (previous === null) return previous;
        const next = { ...previous };
        for (const field of FIELD_ORDER) {
          if (hasFieldData(detailForWrite, field)) next[field] = value;
        }
        return next;
      });
    },
    [detailForWrite],
  );

  /** Deliberate close buttons may cancel a lookup, but never interrupt a write. */
  const requestClose = useCallback(() => {
    if (applying || manualSaving) return;
    onClose();
  }, [applying, manualSaving, onClose]);

  const requestDismiss = useCallback(() => {
    // Both dialogs listen for Escape. Only the notice may dismiss itself while
    // it is on top; the metadata operation and its results stay mounted.
    if (waitNoticeOpen) return;
    if (busy) {
      setWaitNoticeOpen(true);
      return;
    }
    requestClose();
  }, [busy, waitNoticeOpen, requestClose]);

  const candidates = result?.candidates ?? [];
  const errors = result?.errors ?? [];
  const searched = result !== null || searchError !== null;

  return (
    <>
    <Dialog
      open={open}
      onClose={requestDismiss}
      className="max-w-3xl"
      title={`${progressLabel ? `${progressLabel} · ` : ""}${mode === "manual" ? "自定义游戏资料" : "确认游戏作品"}`}
      description={
        mode === "manual"
          ? "填写游戏资料后保存，也可以返回搜索修改名称重新匹配。"
          : "从设置中启用的数据源搜索。请核对封面、名称和发售日，确认是同一作品后保存。"
      }
      footer={
        mode === "manual" ? (
          <>
            {onCancelBatch ? (
              <Button variant="ghost" onClick={onCancelBatch} disabled={manualSaving || applying}>
                结束本次导入
              </Button>
            ) : null}
            <Button variant="outline" onClick={requestClose} disabled={applying || manualSaving}>
              {draft ? "跳过此游戏" : "关闭"}
            </Button>
          </>
        ) : (
          <>
            {onCancelBatch ? (
              <Button variant="ghost" onClick={onCancelBatch} disabled={applying}>
                结束本次导入
              </Button>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => setMode("manual")}
              disabled={applying}
              title="不联网，手动填写这些字段"
            >
              手动填写
            </Button>
            <Button variant="outline" onClick={requestClose} disabled={applying}>
              {draft ? "跳过此游戏" : "关闭"}
            </Button>
            {detail ? (
              <Button
                onClick={() => void apply()}
                loading={applying}
                disabled={applying || (selectedFields.length === 0 && !wantsCover)}
              >
                {draft ? "确认是同一作品并导入" : outcome === null
                  ? `应用所选字段（${selectedFields.length}）`
                  : "再次应用"}
              </Button>
            ) : null}
          </>
        )
      }
    >
      {mode === "manual" ? (
        <ManualEntryForm
          gameId={gameId}
          draft={importDraft}
          onCreated={onCreated}
          onSavingChange={setManualSaving}
          onSaved={onApplied}
          onBack={() => setMode("search")}
        />
      ) : (
        <div className="flex flex-col gap-4">
          {localizationEnabled && detail ? (
            <p role="status" className="text-xs text-muted-foreground">
              标签使用离线词典显示中文；简介和保存的资料保留原文。
            </p>
          ) : null}
          {/* Search ------------------------------------------------------- */}
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void runSearch();
            }}
          >
            <div className="flex items-end gap-2">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <span className="text-xs font-medium text-muted-foreground">作品名</span>
                <Input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="例如：CLANNAD / 命运石之门"
                  disabled={searching || applying}
                  autoFocus
                />
              </div>
              <Button type="submit" loading={searching} disabled={searching || applying || !preferencesReady}>
                搜索
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <span className="text-xs font-medium text-muted-foreground">数据源</span>
              {orderedProviders.map((provider) => (
                <label
                  key={provider}
                  className="flex cursor-pointer items-center gap-1.5 text-xs"
                >
                  <input
                    type="checkbox"
                    className="size-3.5 shrink-0 accent-primary"
                    checked={sources.includes(provider)}
                    disabled={searching || applying}
                    onChange={(event) => toggleSource(provider, event.target.checked)}
                  />
                  {PROVIDER_LABELS[provider]}{provider === defaultSource ? '（默认）' : ''}
                </label>
              ))}
              <span className="text-xs text-muted-foreground">
                搜索范围可在设置 → 资料匹配中调整。
              </span>
            </div>
          </form>

          {/* Whole-command failure (empty query, bad source list, …) ------- */}
          {searchError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              搜索失败：{searchError}
            </div>
          ) : null}

          {/* Per-provider failures — never hide these ---------------------- */}
          {errors.length > 0 ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
              <p className="font-medium">
                有 {errors.length} 个数据源没有返回结果，候选列表可能不完整：
              </p>
              <ul className="mt-1 space-y-0.5">
                {errors.map((item) => (
                  <li key={`${item.provider}-${item.message}`} className="break-words">
                    <span className="font-medium">{providerLabel(item.provider)}</span>
                    <span className="text-muted-foreground">：{item.message}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-muted-foreground">
                限流（VNDB 为 200 次 / 5 分钟）与临时 5xx 都属于这一类，稍后重试即可。
              </p>
            </div>
          ) : null}

          {applyError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              应用失败：{applyError}
            </div>
          ) : null}

          {/* Outcome ------------------------------------------------------ */}
          {outcome ? (
            <div className="rounded-md border border-border bg-accent px-3 py-2 text-xs">
              <p className="font-medium">
                已写入 {outcome.fieldsApplied} 个字段
                {outcome.tagsAdded > 0 ? `，新增 ${outcome.tagsAdded} 个标签关联` : ""}。
              </p>
              {outcome.fieldsApplied === 0 && outcome.fieldsRequested > 0 ? (
                <p className="mt-1 text-amber-600 dark:text-amber-500">
                  所选字段在这个数据源里都没有值，实际上没有写入任何内容。
                </p>
              ) : null}
              {outcome.coverPath ? (
                <p className="mt-1 break-all text-muted-foreground">
                  封面已缓存：{outcome.coverPath}
                </p>
              ) : null}
              {outcome.coverError ? (
                <p className="mt-1 break-words text-destructive">
                  封面未缓存：{outcome.coverError}
                  {detail?.coverUrl ? (
                    <button
                      type="button"
                      className="ml-1 underline underline-offset-2"
                      onClick={() => void useRemoteCover()}
                    >
                      改用远程封面地址
                    </button>
                  ) : null}
                </p>
              ) : null}
            </div>
          ) : null}

          {/* Candidates ---------------------------------------------------- */}
          {searching ? (
            <div className="flex flex-col gap-2" aria-busy>
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
                >
                  <Skeleton variant="shimmer" className="h-16 w-12 shrink-0 rounded" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <Skeleton className="h-3.5 w-2/5" />
                    <Skeleton className="h-3 w-1/4" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {!searching && searched && candidates.length === 0 && !searchError ? (
            <EmptyState
              title="没有找到匹配的作品"
              description={
                errors.length > 0
                  ? "至少一个数据源查询失败（见上方错误），候选可能因此为空。可以稍后重试，或直接手动填写。"
                  : "所选数据源都没有返回候选。可以换个关键词，或直接手动填写这些字段。"
              }
              action={
                <Button variant="outline" onClick={() => setMode("manual")}>
                  手动填写字段
                </Button>
              }
            />
          ) : null}

          {!searching && candidates.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-xs text-muted-foreground">
                共 {candidates.length} 个候选，点击一个查看详情：
              </p>
              <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto pr-1">
                {candidates.map((candidate) => {
                  const active =
                    selected?.provider === candidate.provider &&
                    selected.externalId === candidate.externalId;
                  return (
                    <button
                      key={`${candidate.provider}-${candidate.externalId}`}
                      type="button"
                      aria-pressed={active}
                      onClick={() => void choose(candidate)}
                      disabled={applying}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md border px-3 py-2 text-left tap",
                        "hover:border-primary/50 hover:bg-accent",
                        active ? "border-primary bg-accent" : "border-border",
                      )}
                    >
                      <div className="h-16 w-12 shrink-0 overflow-hidden rounded bg-muted">
                        <CoverImage
                          path={candidate.coverUrl}
                          alt={candidate.title}
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="secondary">{candidate.sourceLabel}</Badge>
                          {candidate.rating !== null ? (
                            <Badge variant="outline">{formatScore(candidate.rating)}</Badge>
                          ) : null}
                          {candidate.releaseDate ? (
                            <span className="text-xs text-muted-foreground">
                              {candidate.releaseDate}
                            </span>
                          ) : null}
                        </div>
                        <p className="mt-1 truncate text-sm font-medium">{candidate.title}</p>
                        {candidate.originalTitle &&
                        candidate.originalTitle !== candidate.title ? (
                          <p className="truncate text-xs text-muted-foreground">
                            {candidate.originalTitle}
                          </p>
                        ) : null}
                        <p className="truncate text-[11px] text-muted-foreground">
                          {candidate.provider}:{candidate.externalId}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* Detail + field selection -------------------------------------- */}
          {detailLoading ? (
            <div className="flex gap-4 rounded-md border border-border p-3" aria-busy>
              <Skeleton variant="shimmer" className="h-40 w-28 shrink-0 rounded" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-20 w-full" />
              </div>
            </div>
          ) : null}

          {detailError ? (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              读取详情失败：{detailError}
            </div>
          ) : null}

          {!detailLoading && detail ? (
            <div className="flex flex-col gap-4">
              <div className="flex gap-4 rounded-md border border-border p-3">
                <div className="h-40 w-28 shrink-0 overflow-hidden rounded bg-muted">
                  <CoverImage
                    path={detail.coverUrl}
                    alt={titleFor(detail, titlePreference) || detail.title}
                    className="h-full w-full object-cover"
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-1.5 text-xs">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="secondary">{providerLabel(detail.provider)}</Badge>
                    {detail.externalId ? (
                      <span className="text-muted-foreground">{detail.externalId}</span>
                    ) : null}
                    {detail.descriptionLang ? (
                      <span className="text-muted-foreground">
                        简介语言：{detail.descriptionLang}
                      </span>
                    ) : null}
                  </div>

                  <p className="text-sm font-semibold">匹配作品：{titleFor(detail, titlePreference) || "（无标题）"}</p>
                  {detail.titleOriginal ? (
                    <p className="text-muted-foreground">原名：{detail.titleOriginal}</p>
                  ) : null}
                  <p className="text-muted-foreground">
                    开发商：{detail.developer ?? "—"} · 发售日：{detail.releaseDate ?? "—"}
                  </p>

                  {/* Multi-source ratings, as returned ---------------------- */}
                  {detail.ratings.length > 0 ? (
                    <p className="text-muted-foreground">
                      多源评分：
                      {detail.ratings.map(formatSourceRating).join(" · ")}
                      {detail.rating !== null ? `　→ 写入 ${formatScore(detail.rating)}` : ""}
                    </p>
                  ) : (
                    <p className="text-muted-foreground">
                      评分：{detail.rating === null ? "—" : formatScore(detail.rating)}
                    </p>
                  )}

                  {detail.tags.length > 0 ? (
                    <div className="flex flex-wrap gap-1 pt-0.5">
                      {detail.tags.map((tag) => (
                        <Badge key={tag} variant="outline">
                          <span title={tag}>{t(tag)}</span>
                        </Badge>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">标签：—</p>
                  )}
                </div>
              </div>

              {/* Attribution is a licence requirement, not decoration. */}
              <p className="rounded-md border border-border px-3 py-1.5 text-[11px] text-muted-foreground">
                数据来源署名：
                <span className="font-medium text-foreground">
                  {detail.attribution ?? providerLabel(detail.provider)}
                </span>
                （依据数据源条款要求标注）
              </p>

              {/* Field selection ----------------------------------------- */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium">选择要写入的字段</span>
                <span className="flex items-center gap-2">
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={() => selectAllFields(true)}
                  >
                    全选有数据的字段
                  </button>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    onClick={() => selectAllFields(false)}
                  >
                    全不选
                  </button>
                </span>
              </div>

              <div className="flex flex-col gap-1.5">
                {FIELD_ORDER.map((field) => {
                  const data = hasFieldData(detailForWrite ?? detail, field);
                  const isChecked = checked?.[field] ?? false;
                  const note = FIELD_NOTES[field];
                  return (
                    <label
                      key={field}
                      className={cn(
                        "flex items-start gap-2 rounded-md border border-border px-2.5 py-2 text-xs",
                        data ? "cursor-pointer hover:bg-accent/50" : "opacity-60",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-3.5 shrink-0 accent-primary"
                        checked={isChecked}
                        disabled={!data || applying}
                        onChange={(event) => toggleField(field, event.target.checked)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-medium">{FIELD_LABELS[field]}</span>
                          {data ? null : <Badge variant="status">上游无数据</Badge>}
                        </span>
                        <span className="mt-0.5 block max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-muted-foreground">
                          {data ? fieldPreview(displayDetail ?? detail, field) : "该数据源没有返回这个字段"}
                        </span>
                        {note && data ? (
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {note}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  );
                })}

                {/* Cover is not a `metadata_apply` field: it is cached first. */}
                <label
                  className={cn(
                    "flex items-start gap-2 rounded-md border border-border px-2.5 py-2 text-xs",
                    detail.coverUrl ? "cursor-pointer hover:bg-accent/50" : "opacity-60",
                  )}
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5 shrink-0 accent-primary"
                    checked={coverChecked}
                    disabled={!detail.coverUrl || applying}
                    onChange={(event) => setCoverChecked(event.target.checked)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="font-medium">封面（保存到管理器）</span>
                      {detail.coverUrl ? null : <Badge variant="status">上游无数据</Badge>}
                    </span>
                    <span className="mt-0.5 block break-all text-muted-foreground">
                      {detail.coverUrl ?? "该数据源没有返回封面"}
                    </span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">
                      删除游戏本体后仍会保留，支持离线查看。
                    </span>
                  </span>
                </label>
              </div>

              {checked?.tags && detail.tags.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">标签写入方式</span>
                  <Select<MetadataTagMode>
                    value={tagMode}
                    onValueChange={setTagMode}
                    options={TAG_MODE_OPTIONS}
                    disabled={applying}
                    className="w-64"
                    aria-label="标签写入方式"
                  />
                </div>
              ) : null}

              <p className="text-[11px] text-muted-foreground">
                只写入勾选的字段：不会清空未勾选的列，也不会碰状态、路径、备注等其它字段。
              </p>
            </div>
          ) : null}
        </div>
      )}
    </Dialog>
    <ImportWaitDialog open={open && busy && waitNoticeOpen} onClose={() => setWaitNoticeOpen(false)} />
    </>
  );
}
