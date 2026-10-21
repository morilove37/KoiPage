import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ImportWaitDialog } from "@/features/metadata/ImportWaitDialog";
import { metadataDetail, metadataSearch } from "@/lib/db";
import type { GameInput, MetadataCandidate, MetadataDetail } from "@/lib/db";
import { createGameFromMetadata } from "@/features/metadata/create-game";
import { ALL_PROVIDERS, FIELD_ORDER, errorMessage, hasFieldData, providerLabel, titleFor } from "@/features/metadata/fields";

type Status = "pending" | "searching" | "loading" | "saving" | "imported" | "review" | "manual" | "failed";
interface ImportRow { draft: GameInput; status: Status; message: string; }
export interface PendingImport { draft: GameInput; manual: boolean; }

interface Props {
  drafts: GameInput[];
  onFinished: () => void;
  onClose: () => void;
  onManual: (remaining: PendingImport[]) => void;
}

const LABELS: Record<Status, string> = {
  pending: "等待导入", searching: "正在搜索", loading: "获取资料", saving: "正在保存",
  imported: "已导入", review: "待确认匹配", manual: "未找到，待自定义", failed: "失败，待处理",
};

/** Sequential requests preserve result order and avoid a burst against providers. */
export default function BatchImportDialog({ drafts, onFinished, onClose, onManual }: Props) {
  const [rows, setRows] = useState<ImportRow[]>(() => drafts.map(draft => ({ draft, status: "pending", message: "" })));
  const [running, setRunning] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [waitNoticeOpen, setWaitNoticeOpen] = useState(false);
  const stopRef = useRef(false);
  const started = useRef(false);
  const alive = useRef(false);

  useEffect(() => {
    if (!running) setWaitNoticeOpen(false);
  }, [running]);

  useEffect(() => {
    alive.current = true;
    stopRef.current = false;
    const timer = window.setTimeout(() => {
      // Effect replay in StrictMode must not start a second import job.
      if (started.current) return;
      started.current = true;
      const update = (index: number, status: Status, message = "") => {
        if (alive.current) setRows(current => current.map((row, i) => i === index ? { ...row, status, message } : row));
      };
      const shouldStop = () => stopRef.current || !alive.current;
      void (async () => {
        try {
          for (let index = 0; index < drafts.length; index++) {
            if (shouldStop()) break;
            const draft = drafts[index];
            try {
              update(index, "searching");
              const found = await metadataSearch(draft.title, [...ALL_PROVIDERS]);
              if (shouldStop()) { update(index, "pending"); break; }
              if (found.automaticCandidates.length === 0) {
                if (found.candidates.length === 0 && found.errors.length > 0) {
                  update(index, "failed", found.errors.map(error => `${providerLabel(error.provider)}：${error.message}`).join("；"));
                } else {
                  update(index, found.candidates.length > 0 ? "review" : "manual", found.candidates.length > 0 ? "匹配不够确定，请逐款确认。" : "没有匹配结果，可手动填写资料。");
                }
                continue;
              }
              const warnings = found.errors.map(error => `${providerLabel(error.provider)}：${error.message}`);
              let first: MetadataCandidate | null = null;
              let detail: MetadataDetail | null = null;
              for (const candidate of found.automaticCandidates) {
                if (shouldStop()) break;
                update(index, "loading", `${providerLabel(candidate.provider)} · ${candidate.title}`);
                try {
                  detail = await metadataDetail(candidate.provider, candidate.externalId);
                  first = candidate;
                  break;
                } catch (cause) { warnings.push(`${providerLabel(candidate.provider)}：${errorMessage(cause)}`); }
              }
              if (shouldStop()) { update(index, "pending"); break; }
              if (!detail || !first) throw new Error(warnings.join("；") || "候选资料读取失败。");
              const matched = `${providerLabel(first.provider)} · ${first.title}`;
              // The confirmed search name is retained by metadataInput.
              update(index, "saving", matched);
              // Use the localized title (Chinese, then original script) instead
              // of the English search key the pending import was created with.
              const resolvedTitle = titleFor(detail, "zh") || draft.title;
              const result = await createGameFromMetadata(
                { ...draft, title: resolvedTitle }, detail, FIELD_ORDER.filter(field => hasFieldData(detail, field)), Boolean(detail.coverUrl?.trim()),
              );
              update(index, "imported", [`${result.game.title} · ${detail.attribution || providerLabel(first.provider)}`, ...warnings, result.coverWarning].filter(Boolean).join("；"));
            } catch (cause) {
              update(index, "failed", errorMessage(cause));
            }
          }
        } finally {
          if (alive.current) { setRunning(false); onFinished(); }
        }
      })();
    }, 0);
    return () => { window.clearTimeout(timer); alive.current = false; stopRef.current = true; };
  }, [drafts, onFinished]);

  const imported = rows.filter(row => row.status === "imported").length;
  const done = rows.filter(row => ["imported", "review", "manual", "failed"].includes(row.status)).length;
  const remaining = rows.filter(row => row.status !== "imported");

  const requestDismiss = () => {
    // Escape should close only the notice when it is above the import dialog.
    if (waitNoticeOpen) return;
    if (running) setWaitNoticeOpen(true);
    else onClose();
  };

  return (
    <>
    <Dialog open title="一键导入" className="max-w-2xl" onClose={requestDismiss}
      description="优先采用设置中默认数据源的可信匹配，没有合适结果或资料读取失败时使用其他来源；不确定的匹配交由逐款确认。"
      footer={running ? (
        <Button variant="outline" disabled={stopping} onClick={() => { stopRef.current = true; setStopping(true); }}>
          {stopping ? "正在停止…" : "停止后续导入"}
        </Button>
      ) : (
        <>
          <Button variant="outline" onClick={onClose}>完成</Button>
          {remaining.length > 0 ? <Button onClick={() => onManual(remaining.map(row => ({ draft: row.draft, manual: row.status === "manual" })))}>
            逐款处理剩余（{remaining.length}）
          </Button> : null}
        </>
      )}>
      <div role="status" aria-live="polite" className="mb-3 text-sm">
        {running ? `已处理 ${done} / ${rows.length} 款，已导入 ${imported} 款` : `已导入 ${imported} 款，待处理 ${remaining.length} 款`}
        {stopping && running ? <p className="mt-1 text-xs text-muted-foreground">当前请求完成后停止，已保存的游戏会保留。</p> : null}
      </div>
      <div role="progressbar" aria-label="导入进度" aria-valuemin={0} aria-valuemax={rows.length} aria-valuenow={done} className="mb-4 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full bg-primary transition-[width]" style={{ width: `${done / Math.max(1, rows.length) * 100}%` }} />
      </div>
      {running ? (
        <p className="mb-4 text-xs leading-relaxed text-muted-foreground">
          导入速度取决于数据源速度，导入较慢请耐心等待或之后再试；同一时间内多次导入可能会被限流，等待一段时间即可。
        </p>
      ) : null}
      <ul className="divide-y divide-border">
        {rows.map(row => <li key={row.draft.installPath} data-import-status={row.status} className="py-3">
          <div className="flex items-start justify-between gap-3 text-sm">
            <span className="min-w-0 break-words font-medium">{row.draft.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{LABELS[row.status]}</span>
          </div>
          {row.message ? <p className="mt-1 break-words text-xs text-muted-foreground">{row.message}</p> : null}
        </li>)}
      </ul>
    </Dialog>
    <ImportWaitDialog open={running && waitNoticeOpen} onClose={() => setWaitNoticeOpen(false)} />
    </>
  );
}
