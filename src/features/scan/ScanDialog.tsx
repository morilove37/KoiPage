import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { inspectExeFile, scanRootsList } from "@/lib/db";
import type { GameInput } from "@/types/game";
import { cn } from "@/lib/utils";

import {
  baseName,
  candidateToInput,
  formatSize,
  scanDirectory,
  type ScanCandidate,
} from "./types";
import { useScanFolderTip } from "./ScanFolderTip";

/**
 * Scan-and-import dialog.
 *
 * Flow: choose one or more executables, or scan a root directory -> group by
 * the executable's parent directory -> confirm one executable and one title per
 * game -> prepare drafts. A game is only saved after the metadata/manual step.
 *
 * The dialog renders as an overlay rather than a portal so it works without an
 * extra dependency; `onClose` is called for both cancel and success, while
 * `onConfirmed` only prepares the next step, without writing to the database.
 */

/** Per-row editable state, keyed by `folderPath`. */
interface RowState {
  selected: boolean;
  title: string;
  exePath: string | null;
}

export interface ScanDialogProps {
  /** Whether the dialog is visible. */
  open: boolean;
  /** Called when the user dismisses the dialog (cancel, backdrop, Esc). */
  onClose: () => void;
  /** Continue with confirmed drafts; no game is created at this step. */
  onConfirmed: (games: GameInput[], mode: "manual" | "automatic") => void;
  /** Pre-filled root directory. */
  defaultPath?: string;
  /**
   * Folders to scan automatically when the dialog opens. Used by the tools
   * page after extraction so the user lands on the review list directly.
   */
  initialRoots?: string[];
}

/** A row plus its derived imports, resolved before the import loop. */
interface ResolvedRow {
  candidate: ScanCandidate;
  title: string;
  exePath: string | null;
}

function rowKey(candidate: ScanCandidate): string {
  return candidate.folderPath;
}

function folderKey(path: string): string {
  return path.replace(/\//g, "\\").replace(/\\+$/, "").toLocaleLowerCase();
}

/** One review row per game folder, even if several exe files were selected. */
function groupByGameFolder(found: ScanCandidate[]): ScanCandidate[] {
  const grouped = new Map<string, ScanCandidate>();
  for (const candidate of found) {
    const key = folderKey(candidate.folderPath);
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, candidate);
      continue;
    }
    const exePaths = [...current.exePaths];
    for (const exe of candidate.exePaths) {
      if (!exePaths.some((path) => path.toLocaleLowerCase() === exe.toLocaleLowerCase())) {
        exePaths.push(exe);
      }
    }
    grouped.set(key, {
      ...current,
      exePaths,
      alreadyImported: current.alreadyImported || candidate.alreadyImported,
    });
  }
  return [...grouped.values()];
}

/** Initial editable state for one candidate: unselected when already imported. */
function initialRow(candidate: ScanCandidate): RowState {
  return {
    selected: !candidate.alreadyImported,
    title: candidate.suggestedTitle,
    exePath: candidate.suggestedExe,
  };
}

export default function ScanDialog({
  open: isOpen,
  onClose,
  onConfirmed,
  defaultPath,
  initialRoots,
}: ScanDialogProps) {
  const [rootPath, setRootPath] = useState(defaultPath ?? "");
  const [maxDepth, setMaxDepth] = useState(3);
  const [candidates, setCandidates] = useState<ScanCandidate[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const scanFolderTip = useScanFolderTip();
  // Guards the async import loop against a dialog that closed mid-flight.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Offer the configured scan roots as one-click starting points.
  const [roots, setRoots] = useState<string[]>([]);
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    scanRootsList()
      .then((list) => {
        if (!cancelled) setRoots(list.map((root) => root.path));
      })
      .catch(() => {
        if (!cancelled) setRoots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  // Esc closes the dialog, but never while a scan/import/fetch is running, and
  // never while the one-time folder tip sits on top (its own Esc closes that).
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !scanning && !scanFolderTip.open) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, scanning, scanFolderTip.open, onClose]);

  /** Shared post-scan state update for both the dialog and a root shortcut. */
  const applyScan = useCallback((found: ScanCandidate[]) => {
    const grouped = groupByGameFolder(found);
    setCandidates(grouped);
    const next: Record<string, RowState> = {};
    for (const candidate of grouped) next[rowKey(candidate)] = initialRow(candidate);
    setRows(next);
    if (grouped.length === 0) {
      setNotice("没有发现可导入的游戏目录。试试提高扫描深度，或换一个根目录。");
    } else {
      const imported = grouped.filter((c) => c.alreadyImported).length;
      setNotice(
        imported > 0
          ? `识别出 ${grouped.length} 个游戏，其中 ${imported} 个已导入。每个游戏只能选择一个启动程序。`
          : `识别出 ${grouped.length} 个游戏。请确认游戏名和启动程序。`,
      );
    }
  }, []);

  // Folders handed over by 实用工具 → 游戏解压 are scanned as soon as the dialog
  // opens, so the user lands directly on the review list.
  useEffect(() => {
    if (!isOpen || !initialRoots || initialRoots.length === 0) return;
    let cancelled = false;
    void (async () => {
      setScanning(true);
      setError(null);
      setNotice(null);
      const found: ScanCandidate[] = [];
      const failures: string[] = [];
      try {
        for (const root of initialRoots) {
          try {
            found.push(...(await scanDirectory(root, 5)));
          } catch (cause) {
            failures.push(`${baseName(root)}：${String(cause)}`);
          }
        }
        if (cancelled || !aliveRef.current) return;
        setRootPath(initialRoots[0] ?? "");
        applyScan(found);
        if (found.length === 0) {
          setNotice("解压出的文件夹里没有发现可导入的启动文件。");
        }
        if (failures.length > 0) {
          setError(`部分解压目录扫描失败：${failures.join("；")}`);
        }
      } finally {
        if (!cancelled && aliveRef.current) setScanning(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, initialRoots, applyScan]);

  const pickExecutables = useCallback(async () => {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const selected = await open({
        title: "选择一个或多个游戏启动程序",
        multiple: true,
        filters: [{ name: "可执行文件或启动脚本", extensions: ["exe", "bat", "cmd"] }],
      });
      if (selected === null) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const inspected = await Promise.allSettled(paths.map((path) => inspectExeFile(path)));
      if (!aliveRef.current) return;
      const found = inspected.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const failed = inspected.length - found.length;
      applyScan(found);
      if (failed > 0) setError(`${failed} 个启动文件无法读取，其余项目仍可继续导入。`);
    } catch (cause) {
      if (aliveRef.current) setError(`无法选择启动文件：${String(cause)}`);
    } finally {
      if (aliveRef.current) setScanning(false);
    }
  }, [applyScan]);

  const runScan = useCallback(
    async (path: string, depth: number) => {
      const trimmed = path.trim();
      if (!trimmed) {
        setError("请先选择要扫描的根目录。");
        return;
      }
      setScanning(true);
      setError(null);
      setNotice(null);
      try {
        const found = await scanDirectory(trimmed, depth);
        if (!aliveRef.current) return;
        setRootPath(trimmed);
        applyScan(found);
      } catch (cause) {
        if (!aliveRef.current) return;
        setCandidates([]);
        setRows({});
        setError(`扫描失败：${String(cause)}`);
      } finally {
        if (aliveRef.current) setScanning(false);
      }
    },
    [applyScan],
  );

  const pickDirectoryDialog = useCallback(async () => {
    setError(null);
    try {
      // Verified against @tauri-apps/plugin-dialog 2.8.2 `index.d.ts`:
      // with `directory: true` (and no `multiple`), `open` resolves to
      // `string | null` — the path, or null when the user cancels.
      const selected = await open({ directory: true, title: "选择扫描根目录" });
      if (typeof selected !== "string") return; // cancelled
      setRootPath(selected);
      await runScan(selected, maxDepth);
    } catch (cause) {
      setError(`无法打开目录选择对话框：${String(cause)}`);
    }
  }, [maxDepth, runScan]);

  /** The first folder pick shows a one-time "keep games in one folder" tip. */
  const pickDirectory = useCallback(() => {
    scanFolderTip.guard(() => {
      void pickDirectoryDialog();
    });
  }, [pickDirectoryDialog, scanFolderTip.guard]);

  // ---- selection helpers -------------------------------------------------

  const selectableKeys = useMemo(
    () => candidates.filter((c) => !c.alreadyImported).map(rowKey),
    [candidates],
  );

  const selectedKeys = useMemo(
    () => candidates.filter((c) => rows[rowKey(c)]?.selected).map(rowKey),
    [candidates, rows],
  );

  /**
   * Select/deselect every row.
   *
   * Only rows that are *not* already imported are touched: re-importing an
   * existing folder would violate the unique index on `games.install_path`, so
   * "全选" must never tick them. Clearing (the "反选" button) is allowed to
   * touch every row.
   */
  const setAll = useCallback(
    (selected: boolean) => {
      setRows((previous) => {
        const next = { ...previous };
        for (const [key, row] of Object.entries(next)) {
          if (selected && row.selected) continue;
          const candidate = candidates.find((item) => rowKey(item) === key);
          if (selected && candidate?.alreadyImported) continue;
          next[key] = { ...row, selected };
        }
        return next;
      });
    },
    [candidates],
  );

  const toggleOne = useCallback((key: string) => {
    setRows((previous) => ({
      ...previous,
      [key]: { ...previous[key], selected: !previous[key].selected },
    }));
  }, []);

  const setRowTitle = useCallback((key: string, title: string) => {
    setRows((previous) => ({ ...previous, [key]: { ...previous[key], title } }));
  }, []);

  const setRowExe = useCallback((key: string, exePath: string) => {
    setRows((previous) => ({ ...previous, [key]: { ...previous[key], exePath } }));
  }, []);

  // ---- import ------------------------------------------------------------

  const runImport = useCallback((mode: "manual" | "automatic") => {
    const resolved: ResolvedRow[] = candidates
      .filter((candidate) => !candidate.alreadyImported && rows[rowKey(candidate)]?.selected)
      .map((candidate) => {
        const row = rows[rowKey(candidate)];
        return {
          candidate,
          title: row.title.trim(),
          exePath: row.exePath,
        };
      });

    if (resolved.length === 0) {
      setError("请至少勾选一个要导入的目录。");
      return;
    }

    if (resolved.some((row) => !row.title || !row.exePath)) {
      setError("请为每个选中的游戏填写名称，并选择一个 exe。");
      return;
    }
    onConfirmed(resolved.map((row) =>
      candidateToInput(row.candidate, { title: row.title, exePath: row.exePath }),
    ), mode);
    setCandidates([]);
    setRows({});
    setNotice(null);
    setError(null);
    onClose();
  }, [candidates, rows, onConfirmed, onClose]);

  if (!isOpen) return null;

  const busy = scanning;
  const allSelectableSelected =
    selectableKeys.length > 0 && selectableKeys.every((key) => rows[key]?.selected);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="添加游戏"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-lg">
        {/* header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">添加游戏</h2>
            <p className="text-xs text-muted-foreground">
              选择 exe 或 .bat 启动脚本，或扫描目录；程序会按启动文件的上一级目录归并游戏。
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            关闭
          </Button>
        </div>

        {/* controls */}
        <div className="space-y-3 border-b border-border px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={() => void pickExecutables()} loading={scanning} disabled={busy}>
              选择启动文件…
            </Button>
            <span className="text-xs text-muted-foreground">
              可多选；同一游戏目录最终只保留一个启动程序
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            <span>或者扫描整个目录</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">根目录</span>
              <Input
                value={rootPath}
                placeholder="尚未选择目录"
                spellCheck={false}
                onChange={(event) => setRootPath(event.target.value)}
                disabled={busy}
              />
            </label>
            <label className="flex w-24 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">深度</span>
              <Input
                type="number"
                min={1}
                max={64}
                value={maxDepth}
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  setMaxDepth(Number.isFinite(parsed) ? Math.min(64, Math.max(1, parsed)) : 1);
                }}
                disabled={busy}
              />
            </label>
            <Button variant="outline" onClick={pickDirectory} disabled={busy}>
              选择目录…
            </Button>
            <Button
              onClick={() => void runScan(rootPath, maxDepth)}
              loading={scanning}
              disabled={busy || rootPath.trim().length === 0}
            >
              开始扫描
            </Button>
          </div>

          {roots.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">已配置的扫描根：</span>
              {roots.map((root) => (
                <button
                  key={root}
                  type="button"
                  className="rounded-md border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                  title={root}
                  disabled={busy}
                  onClick={() => {
                    setRootPath(root);
                    void runScan(root, maxDepth);
                  }}
                >
                  {baseName(root)}
                </button>
              ))}
            </div>
          ) : null}
          <p className="text-xs leading-relaxed text-muted-foreground">
            支持 exe 或 .bat/.cmd 补丁脚本；如果脚本启动游戏后立即退出，本次游玩时长可能无法统计。
          </p>
        </div>

        {/* status */}
        {error ? (
          <div className="border-b border-border bg-destructive/10 px-4 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
            {notice}
          </div>
        ) : null}

        {/* A wrong exe or title here silently produces a broken game row, so the
            warning is shown right above the review list in the destructive colour. */}
        {!scanning && candidates.length > 0 ? (
          <div className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs font-medium text-destructive">
            请确认游戏启动文件正确和游戏名称正确，否则会导入错误的游戏或导致游戏无法启动。
          </div>
        ) : null}

        {/* list */}
        <div className="flex items-center justify-between border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span>
            共 {candidates.length} 个候选，已选 {selectedKeys.length} 个
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || selectableKeys.length === 0}
              onClick={() => setAll(true)}
            >
              全选
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || selectedKeys.length === 0}
              onClick={() => setAll(false)}
            >
              清除选择
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {scanning ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              正在扫描…
            </div>
          ) : candidates.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-muted-foreground">
              请选择启动文件（exe / .bat / .cmd），或选择根目录开始扫描。
            </div>
          ) : (
            <ul className="divide-y divide-border">
              {candidates.map((candidate) => {
                const key = rowKey(candidate);
                const row = rows[key] ?? initialRow(candidate);
                return (
                  <li
                    key={key}
                    className={cn(
                      "flex gap-3 px-4 py-3",
                      candidate.alreadyImported && "bg-muted/40",
                    )}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-[hsl(var(--primary))]"
                      checked={row.selected}
                      onChange={() => toggleOne(key)}
                      disabled={busy || candidate.alreadyImported}
                      aria-label={`导入 ${row.title}`}
                    />
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <Input
                          className="h-8 flex-1 text-sm"
                          value={row.title}
                          onChange={(event) => setRowTitle(key, event.target.value)}
                          disabled={busy}
                          aria-label="标题"
                        />
                        {candidate.alreadyImported ? (
                          <Badge variant="secondary" className="shrink-0">
                            已导入
                          </Badge>
                        ) : null}
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                          {formatSize(candidate.sizeBytes)}
                        </span>
                      </div>

                      <p
                        className="truncate text-xs text-muted-foreground"
                        title={candidate.folderPath}
                      >
                        {candidate.folderPath}
                      </p>

                      <div className="flex flex-wrap items-center gap-2">
                        {candidate.exePaths.length > 0 ? (
                          <Select
                            size="sm"
                            aria-label="启动程序"
                            className="w-56 max-w-xs"
                            value={row.exePath ?? ""}
                            onValueChange={(next) => setRowExe(key, next)}
                            disabled={busy}
                            options={candidate.exePaths.map((exePath) => ({
                              value: exePath,
                              label: baseName(exePath),
                            }))}
                          />
                        ) : (
                          <span className="text-xs text-destructive">未找到启动文件</span>
                        )}
                        <span
                          className="truncate text-xs text-muted-foreground"
                          title={candidate.coverPath ?? undefined}
                        >
                          {candidate.coverPath
                            ? `封面：${baseName(candidate.coverPath)}`
                            : "封面：未识别"}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* footer */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-4 py-3">
          <span className="text-xs text-muted-foreground">
            一键导入优先选择默认数据源的结果，没有结果时再选择搜索结果第一项；若要确保准确性，请使用「逐款确认」逐条导入。
          </span>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {allSelectableSelected && selectableKeys.length > 0
                    ? "已全选可导入项"
                    : ""}
            </span>
            <Button variant="outline" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button
              variant="outline"
              onClick={() => runImport("manual")}
              disabled={busy || selectedKeys.length === 0}
            >
              逐款确认（{selectedKeys.length}）
            </Button>
            {selectedKeys.length > 1 ? <Button
              onClick={() => runImport("automatic")}
              disabled={busy}
            >
              一键导入（{selectedKeys.length}）
            </Button> : null}
          </div>
        </div>
      </div>
      {scanFolderTip.dialog}
    </div>
  );
}
