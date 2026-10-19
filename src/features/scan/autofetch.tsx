/**
 * "导入后自动获取资料" — shared UI and plumbing for the two import dialogs.
 *
 * `metadata_autofetch` runs a whole batch inside one Rust command. It is
 * **serial with a ~700 ms gap between games** (anonymous NextMoe allows 30
 * requests/minute, VNDB 200 per 5 minutes), so importing 20 games takes well
 * over 15 seconds. That is why this module exists:
 *
 * - a checkbox so the feature is opt-out (unticking it must mean *zero*
 *   requests, not just hidden results),
 * - a live progress bar fed by the `metadata-autofetch-progress` event, so a
 *   slow batch never looks like a freeze,
 * - a summary that reports the four outcomes separately instead of a vague
 *   "done".
 *
 * The one rule it must never break: a `needsReview` outcome is **deliberately
 * not written** by the backend, because a wrong match would silently replace
 * the user's title with an unrelated work's. The summary therefore only tells
 * the user to go and confirm it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { Badge } from "@/components/ui/badge";
import { providerLabel } from "@/features/metadata/fields";
import { AUTOFETCH_PROGRESS_EVENT, metadataAutofetch } from "@/lib/db";
import type {
  AutofetchOutcome,
  AutofetchSummary,
  AutofetchStatus,
  AutofetchProgress,
} from "@/lib/db";
import { cn } from "@/lib/utils";

/** Live progress for the game currently being looked up. */
export interface AutofetchProgressState {
  /** 1-based position in the batch. */
  index: number;
  total: number;
  title: string;
  /** Outcome of the game this event was emitted for. */
  status: AutofetchStatus;
}

export interface UseAutofetchResult {
  /** Whether the user wants the batch to run. Defaults to true (opt-out). */
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  running: boolean;
  progress: AutofetchProgressState | null;
  summary: AutofetchSummary | null;
  /** Whole-command failure (a per-game failure lands in the summary instead). */
  error: string | null;
  /** Runs the batch; resolves `null` when skipped, failed, or nothing to do. */
  run: (gameIds: number[]) => Promise<AutofetchSummary | null>;
  /** Clears progress/summary/error, e.g. when the dialog is re-opened. */
  reset: () => void;
}

const STATUS_LABELS: Record<AutofetchStatus, string> = {
  applied: "已自动填入",
  needsReview: "待确认",
  noMatch: "未找到",
  failed: "获取失败",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  exact: "完全一致",
  strong: "高度相似",
  weak: "相似度较低",
};

/**
 * Wrap the batch command with progress and error handling.
 *
 * The listener is registered **before** `invoke`, otherwise the first game's
 * event can fire while `listen` is still resolving and be lost.
 */
export function useAutofetch(): UseAutofetchResult {
  const [enabled, setEnabled] = useState(true);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<AutofetchProgressState | null>(null);
  const [summary, setSummary] = useState<AutofetchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setProgress(null);
    setSummary(null);
    setError(null);
  }, []);

  const run = useCallback(
    async (gameIds: number[]): Promise<AutofetchSummary | null> => {
      // Unticking the box must mean "make no request at all".
      if (!enabled || gameIds.length === 0) return null;

      setRunning(true);
      setProgress(null);
      setSummary(null);
      setError(null);

      let unlisten: UnlistenFn | null = null;
      try {
        unlisten = await listen<AutofetchProgress>(AUTOFETCH_PROGRESS_EVENT, (event) => {
          const payload = event.payload;
          if (payload === null || payload === undefined) return;
          setProgress({
            index: payload.index,
            total: payload.total,
            title: payload.title,
            status: payload.status,
          });
        });
        if (!aliveRef.current) {
          // Unmounted while the listener was being registered: drop it at once
          // rather than leaking a subscription for the next run.
          unlisten();
          unlisten = null;
        }
      } catch {
        // No event bridge (e.g. running outside Tauri): the batch still works,
        // it just reports no live progress.
        unlisten = null;
      }

      try {
        const result = await metadataAutofetch(gameIds);
        if (aliveRef.current) setSummary(result);
        return result;
      } catch (cause) {
        // Rust rejects with a plain string, not an Error.
        const message = cause instanceof Error ? cause.message : String(cause);
        if (aliveRef.current) setError(message);
        return null;
      } finally {
        if (unlisten !== null) unlisten();
        if (aliveRef.current) {
          setRunning(false);
          setProgress(null);
        }
      }
    },
    [enabled],
  );

  return { enabled, setEnabled, running, progress, summary, error, run, reset };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

export interface AutofetchToggleProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  /** How many games are about to be imported, used for a rough time estimate. */
  count?: number;
}

/** Opt-out checkbox shown next to the import button. */
export function AutofetchToggle({ checked, onChange, disabled, count }: AutofetchToggleProps) {
  const estimate =
    count !== undefined && count > 0 ? `约 ${Math.max(1, Math.round(count * 3))} 秒` : "";
  return (
    <label
      className={cn(
        "flex items-center gap-1.5 text-xs",
        disabled ? "opacity-60" : "cursor-pointer",
      )}
      title="导入后立即联网搜索并自动填入可信的资料；匹配不确定的只会提示，不会写入。"
    >
      <input
        type="checkbox"
        className="size-3.5 shrink-0 accent-[hsl(var(--primary))]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>导入后自动获取资料</span>
      <span className="text-muted-foreground">
        {estimate === "" ? "（逐部查询，较慢）" : `（逐部查询，${estimate}）`}
      </span>
    </label>
  );
}

export interface AutofetchPanelProps {
  running: boolean;
  progress: AutofetchProgressState | null;
  summary: AutofetchSummary | null;
  error: string | null;
  /** Games this import created, so a failure can still report what landed. */
  importedCount: number;
}

/**
 * Progress bar and post-batch summary.
 *
 * Renders nothing until the batch starts, so the dialogs can mount it
 * unconditionally.
 */
export function AutofetchPanel({
  running,
  progress,
  summary,
  error,
  importedCount,
}: AutofetchPanelProps) {
  if (running) {
    const percent =
      progress === null
        ? 0
        : Math.min(100, Math.round((progress.index / Math.max(1, progress.total)) * 100));
    return (
      <div className="border-b border-border bg-muted/40 px-4 py-2.5 text-xs">
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">正在联网获取资料…</span>
          <span className="tabular-nums text-muted-foreground">
            {progress === null
              ? "准备中…"
              : `已完成 ${progress.index} / 共 ${progress.total} 部`}
          </span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-border">
          <div
            className="h-full rounded bg-primary transition-[width] duration-180 ease-smooth"
            style={{ width: `${percent}%` }}
          />
        </div>
        {progress !== null ? (
          // `index` counts *finished* games: Rust emits the event after each
          // lookup, carrying that game's final status.
          <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
            <span className="min-w-0 flex-1 truncate" title={progress.title}>
              刚完成：{progress.title}
            </span>
            <Badge variant="status">{STATUS_LABELS[progress.status]}</Badge>
          </p>
        ) : null}
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          导入速度取决于数据源速度，导入较慢请耐心等待或之后再试；同一时间内多次导入可能会被限流，等待一段时间即可。
          逐个查询以免触发上游限流（每部间隔约 0.7 秒），期间请勿关闭窗口。
        </p>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs">
        <p className="text-destructive">
          {importedCount > 0
            ? `已导入 ${importedCount} 部，资料获取失败：${error}`
            : `资料获取失败：${error}`}
        </p>
        <p className="mt-0.5 text-muted-foreground">
          游戏已经写进库里了，资料只是附加内容。可以稍后在详情页用「联网获取资料」重试。
        </p>
      </div>
    );
  }

  if (summary === null) return null;

  const applied = summary.outcomes.filter((item) => item.status === "applied");
  const review = summary.outcomes.filter((item) => item.status === "needsReview");
  const noMatch = summary.outcomes.filter((item) => item.status === "noMatch");
  const failed = summary.outcomes.filter((item) => item.status === "failed");

  return (
    <div className="border-b border-border px-4 py-2.5 text-xs">
      <p className="font-medium">资料获取完成</p>
      <ul className="mt-1 space-y-1">
        <li>
          已自动填入 <span className="font-medium tabular-nums">{summary.applied}</span> 部
          {applied.length > 0 ? (
            <span className="text-muted-foreground">：{applied.map(describeApplied).join("、")}</span>
          ) : null}
        </li>

        {review.length > 0 ? (
          <li className="text-amber-600 dark:text-amber-500">
            {summary.needsReview} 部找到候选但匹配不够确定，<span className="font-medium">未写入</span>
            ，请到详情页确认：
            <ul className="mt-0.5 space-y-0.5 pl-4 text-muted-foreground">
              {review.map((item) => (
                <li key={item.gameId}>
                  {item.title}
                  {item.matchedTitle !== null ? ` → 候选「${item.matchedTitle}」` : ""}
                  {describeReview(item)}
                </li>
              ))}
            </ul>
          </li>
        ) : null}

        {noMatch.length > 0 ? (
          <li className="text-muted-foreground">
            {summary.noMatch} 部未找到：
            {noMatch.map((item) => item.title).join("、")}
          </li>
        ) : null}

        {failed.length > 0 ? (
          <li className="text-destructive">
            {summary.failed} 部获取失败：
            <ul className="mt-0.5 space-y-0.5 pl-4">
              {failed.map((item) => (
                <li key={item.gameId}>
                  {item.title}
                  {item.message !== null ? `：${item.message}` : ""}
                </li>
              ))}
            </ul>
          </li>
        ) : null}
      </ul>
      <p className="mt-1.5 text-[11px] text-muted-foreground">
        资料来自鲲 Galgame 论坛 / VNDB / Bangumi / 2DFan，仅写入可信字段；匹配不确定的一律留给你决定。
      </p>
    </div>
  );
}

/** `命运石之门（15 字段，含封面）` — one applied outcome. */
function describeApplied(outcome: AutofetchOutcome): string {
  const fields = `${outcome.fieldsApplied} 字段`;
  const cover = outcome.coverPath !== null ? "，含封面" : "";
  return `${outcome.title}（${fields}${cover}）`;
}

/** `（鲲 Galgame 论坛，相似度较低）` — why a candidate was not written. */
function describeReview(outcome: AutofetchOutcome): string {
  const parts: string[] = [];
  if (outcome.provider !== null) parts.push(providerLabel(outcome.provider));
  if (outcome.confidence !== null) {
    parts.push(CONFIDENCE_LABELS[outcome.confidence] ?? outcome.confidence);
  }
  return parts.length > 0 ? `（${parts.join("，")}）` : "";
}

export default AutofetchPanel;
