import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { ImportWaitDialog } from "@/features/metadata/ImportWaitDialog";
import { metadataDetail, metadataSearch } from "@/lib/db";
import type { GameInput, MetadataCandidate, MetadataDetail } from "@/lib/db";
import { createGameFromMetadata } from "@/features/metadata/create-game";
import { ALL_PROVIDERS, FIELD_ORDER, errorMessage, hasFieldData, providerLabel, titleFor } from "@/features/metadata/fields";

import { ImportQueue, type ImportContext, type ImportOutcome, type ImportStatus } from "./import-queue";
export interface PendingImport { draft: GameInput; manual: boolean; }

interface Props {
  drafts: GameInput[];
  onFinished: () => void;
  onClose: () => void;
  onManual: (remaining: PendingImport[]) => void;
}

const LABELS: Record<ImportStatus, string> = {
  pending: "等待导入", searching: "正在搜索", loading: "获取资料", saving: "正在保存",
  imported: "已导入", review: "待确认匹配", manual: "未找到，待自定义", failed: "失败，待处理",
};

/** Sequential requests preserve result order and avoid a burst against providers. */
export default function BatchImportDialog({ drafts, onFinished, onClose, onManual }: Props) {
  const [queue] = useState(() => new ImportQueue(drafts));
  const [rows, setRows] = useState(queue.rows);
  const [running, setRunning] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [waitNoticeOpen, setWaitNoticeOpen] = useState(false);
  const started = useRef(false);
  const alive = useRef(false);
  const finished = useRef(onFinished);
  finished.current = onFinished;

  async function importOne(draft: GameInput, context: ImportContext): Promise<ImportOutcome> {
    context.update('searching');
    const found = await metadataSearch(draft.title, [...ALL_PROVIDERS]);
    if (context.stopped()) return { status: 'pending', message: '' };
    if (!found.automaticCandidates.length) {
      if (!found.candidates.length && found.errors.length) throw new Error(found.errors.map(error => `${providerLabel(error.provider)}：${error.message}`).join('；'));
      return found.candidates.length ? { status: 'review', message: '匹配不够确定，请逐款确认。' } : { status: 'manual', message: '没有匹配结果，可手动填写资料。' };
    }
    const warnings = found.errors.map(error => `${providerLabel(error.provider)}：${error.message}`);
    let first: MetadataCandidate | null = null;
    let detail: MetadataDetail | null = null;
    for (const candidate of found.automaticCandidates) {
      if (context.stopped()) break;
      context.update('loading', `${providerLabel(candidate.provider)} · ${candidate.title}`);
      try {
        detail = await metadataDetail(candidate.provider, candidate.externalId);
        first = candidate; break;
      } catch (cause) { warnings.push(`${providerLabel(candidate.provider)}：${errorMessage(cause)}`); }
    }
    if (context.stopped()) return { status: 'pending', message: '' };
    if (!detail || !first) throw new Error(warnings.join('；') || '候选资料读取失败。');
    context.update('saving', `${providerLabel(first.provider)} · ${first.title}`);
    const result = await createGameFromMetadata(
      { ...draft, title: titleFor(detail, 'zh') || draft.title }, detail,
      FIELD_ORDER.filter(field => hasFieldData(detail, field)), Boolean(detail.coverUrl?.trim()),
    );
    return { status: 'imported', message: [`${result.game.title} · ${detail.attribution || providerLabel(first.provider)}`, ...warnings, result.coverWarning].filter(Boolean).join('；') };
  }

  async function run(indices: number[]) {
    if (queue.running || !alive.current) return;
    setRunning(true); setStopping(false); setWaitNoticeOpen(false);
    try {
      await queue.run(indices, importOne, next => { if (alive.current) setRows(next); });
    } finally {
      if (alive.current) { setRunning(false); finished.current(); }
    }
  }

  useEffect(() => {
    alive.current = true;
    const timer = window.setTimeout(() => {
      if (started.current) return;
      started.current = true;
      void run(queue.indices('pending'));
    }, 0);
    return () => { window.clearTimeout(timer); alive.current = false; queue.stop(); };
  }, [queue]);

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
        <Button variant="outline" disabled={stopping} onClick={() => { queue.stop(); setStopping(true); }}>
          {stopping ? "正在停止…" : "停止后续导入"}
        </Button>
      ) : (
        <>
          <Button variant="outline" onClick={onClose}>完成</Button>
          {queue.indices('failed').length ? <Button variant="outline" onClick={() => void run(queue.indices('failed'))}>重试失败项（{queue.indices('failed').length}）</Button> : null}
          {queue.indices('pending').length ? <Button variant="outline" onClick={() => void run(queue.indices('pending'))}>继续未开始项（{queue.indices('pending').length}）</Button> : null}
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
        {rows.map((row, index) => <li key={`${index}:${row.draft.installPath}`} data-import-status={row.status} className="py-3">
          <div className="flex items-start justify-between gap-3 text-sm">
            <span className="min-w-0 break-words font-medium">{row.draft.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{LABELS[row.status]}</span>
          </div>
          {row.message ? <p className="mt-1 break-words text-xs text-muted-foreground">{row.message}</p> : null}
          {!running && row.status === 'failed' ? <Button size="sm" variant="outline" className="mt-2" onClick={() => void run([index])}>重试此项</Button> : null}
        </li>)}
      </ul>
    </Dialog>
    <ImportWaitDialog open={running && waitNoticeOpen} onClose={() => setWaitNoticeOpen(false)} />
    </>
  );
}
