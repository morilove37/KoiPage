import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { CoverImage } from "@/components/ui/cover-image";
import { gameCreate, inspectExeFile } from "@/lib/db";

import {
  AutofetchPanel,
  AutofetchToggle,
  useAutofetch,
} from "./autofetch";
import {
  baseName,
  candidateToInput,
  formatSize,
  type ImportedGame,
  type ScanCandidate,
} from "./types";

/**
 * Manual single-exe import dialog.
 *
 * The escape hatch for the cases the scanner cannot place: irregular folder
 * layouts, exes hidden under an unexpected name, or a rejected installer-style
 * launch path. The user picks the exact `.exe`; `inspect_exe_file` returns a
 * candidate whose `suggestedExe` is that file by construction, and the dialog
 * only has to let the user adjust the title / exe / cover before writing one
 * row with `game_create`.
 *
 * `onImported` fires only with games that were actually created; `onClose` is
 * called for cancel and for success alike, mirroring `ScanDialog`.
 */

export interface ImportExeDialogProps {
  /** Whether the dialog is visible. */
  open: boolean;
  /** Called when the user dismisses the dialog (cancel, backdrop, Esc). */
  onClose: () => void;
  /** Called once after a successful import, with the created game. */
  onImported?: (games: ImportedGame[]) => void;
}

/** Path fragment used when the source path has no usable file name. */
const UNKNOWN = "（未知）";

export default function ImportExeDialog({
  open: isOpen,
  onClose,
  onImported,
}: ImportExeDialogProps) {
  const [selectedExe, setSelectedExe] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<ScanCandidate | null>(null);
  const [title, setTitle] = useState("");
  const [exePath, setExePath] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** 1 once a row was written, which also locks the import button. */
  const [importedCount, setImportedCount] = useState(0);
  const autofetch = useAutofetch();

  // Guards the async inspect/import against a dialog closed mid-flight.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Reset on each open so a previous import does not leak into the next one.
  useEffect(() => {
    if (!isOpen) return;
    setSelectedExe(null);
    setCandidate(null);
    setTitle("");
    setExePath(null);
    setInspecting(false);
    setImporting(false);
    setError(null);
    setNotice(null);
    setImportedCount(0);
    autofetch.reset();
  }, [isOpen, autofetch.reset]);

  const busy = inspecting || importing || autofetch.running;

  // Esc closes, but never while a Tauri call is in flight.
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, busy, onClose]);

  /** Run `inspect_exe_file` for a path the user just picked. */
  const inspect = useCallback(async (path: string) => {
    setInspecting(true);
    setError(null);
    setNotice(null);
    try {
      const found = await inspectExeFile(path);
      if (!aliveRef.current) return;
      setCandidate(found);
      setTitle(found.suggestedTitle);
      // The command guarantees this, but fall back to the picked path rather
      // than rendering an empty select if it ever regresses.
      setExePath(found.suggestedExe ?? path);
      if (found.alreadyImported) {
        setNotice("该目录已在游戏库中，继续导入可能因 install_path 唯一约束失败。");
      }
    } catch (cause) {
      if (!aliveRef.current) return;
      setCandidate(null);
      setTitle("");
      setExePath(null);
      setError(`读取失败：${String(cause)}`);
    } finally {
      if (aliveRef.current) setInspecting(false);
    }
  }, []);

  const pickExe = useCallback(async () => {
    setError(null);
    try {
      // Verified against @tauri-apps/plugin-dialog 2.8.2 `index.d.ts`:
      // without `directory: true` and without `multiple`, `open` resolves to
      // `string | null` — the path, or null when the user cancels.
      const selected = await open({
        title: "选择游戏启动程序",
        filters: [{ name: "可执行文件或启动脚本", extensions: ["exe", "bat", "cmd"] }],
      });
      if (typeof selected !== "string" || selected.length === 0) return; // cancelled
      setSelectedExe(selected);
      await inspect(selected);
    } catch (cause) {
      setError(`无法打开文件选择对话框：${String(cause)}`);
    }
  }, [inspect]);

  const runImport = useCallback(async () => {
    if (!candidate) {
      setError("请先选择一个启动程序。");
      return;
    }
    const finalTitle = title.trim() || candidate.folderName;
    if (!finalTitle) {
      setError("请填写游戏标题。");
      return;
    }

    setImporting(true);
    setError(null);
    setNotice(null);
    autofetch.reset();
    try {
      const game = await gameCreate(
        candidateToInput(candidate, { title: finalTitle, exePath }),
      );
      if (!aliveRef.current) return;
      setImportedCount(1);
      setNotice(`已导入「${game.title}」。`);
      onImported?.([game]);

      if (autofetch.enabled) {
        // Stay open: the batch takes a while and the summary has to be
        // readable. `importing` stays true meanwhile, which also blocks the
        // import button so the row cannot be created twice.
        const fetched = await autofetch.run([game.id]);
        if (!aliveRef.current) return;
        // Title, cover and tags may have changed — refetch the library.
        if (fetched !== null) onImported?.([game]);
      } else {
        onClose();
      }
    } catch (cause) {
      if (!aliveRef.current) return;
      setError(`导入失败：${String(cause)}`);
    } finally {
      if (aliveRef.current) setImporting(false);
    }
  }, [
    candidate,
    title,
    exePath,
    onImported,
    onClose,
    autofetch.enabled,
    autofetch.run,
    autofetch.reset,
  ]);

  if (!isOpen) return null;

  const exeOptions = candidate
    ? exePath && !candidate.exePaths.includes(exePath)
      ? [exePath, ...candidate.exePaths]
      : candidate.exePaths
    : [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="手动导入"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-lg">
        {/* header */}
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">手动导入</h2>
            <p className="text-xs text-muted-foreground">
              直接选择游戏的 exe 或 .bat/.cmd 启动脚本导入，适用于目录结构不规则的安装。通过脚本启动时，如果脚本启动游戏后立即退出，游玩时长可能无法统计。
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            关闭
          </Button>
        </div>

        {/* controls */}
        <div className="space-y-3 border-b border-border px-4 py-3">
          <div className="flex items-end gap-2">
            <label className="flex flex-1 flex-col gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">启动程序</span>
              <Input
                value={selectedExe ?? ""}
                placeholder="尚未选择 exe 或 .bat 文件"
                spellCheck={false}
                readOnly
                title={selectedExe ?? undefined}
              />
            </label>
            <Button variant="outline" onClick={() => void pickExe()} disabled={busy}>
              选择程序…
            </Button>
          </div>
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

        <AutofetchPanel
          running={autofetch.running}
          progress={autofetch.progress}
          summary={autofetch.summary}
          error={autofetch.error}
          importedCount={importedCount}
        />

        {/* body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {inspecting ? (
            <div className="py-10 text-center text-sm text-muted-foreground">正在读取…</div>
          ) : !candidate ? (
            <div className="py-10 text-center text-sm text-muted-foreground">
              还没有选择文件。点击「选择程序…」定位游戏启动程序（exe 或 .bat/.cmd）。
            </div>
          ) : (
            <div className="flex gap-4">
              {/* cover preview */}
              <div className="h-40 w-28 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
                <CoverImage
                  path={candidate.coverPath}
                  alt={title || candidate.folderName}
                  className="h-full w-full object-cover"
                />
              </div>

              <div className="min-w-0 flex-1 space-y-2.5">
                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">标题</span>
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    disabled={busy}
                    placeholder={candidate.folderName}
                  />
                </label>

                <label className="flex flex-col gap-1.5">
                  <span className="text-xs font-medium text-muted-foreground">启动程序</span>
                  {exeOptions.length > 0 ? (
                    <Select
                      size="sm"
                      aria-label="启动程序"
                      value={exePath ?? ""}
                      onValueChange={setExePath}
                      disabled={busy}
                      options={exeOptions.map((option) => ({
                        value: option,
                        label: baseName(option),
                      }))}
                    />
                  ) : (
                    <span className="text-xs text-destructive">未找到启动程序</span>
                  )}
                </label>

                <div className="space-y-1 text-xs text-muted-foreground">
                  <p className="truncate" title={candidate.folderPath}>
                    安装目录：{candidate.folderPath || UNKNOWN}
                  </p>
                  <p className="truncate" title={candidate.coverPath ?? undefined}>
                    封面：{candidate.coverPath ? baseName(candidate.coverPath) : "未识别"}
                  </p>
                  <p>目录大小：{formatSize(candidate.sizeBytes)}</p>
                </div>

                {candidate.alreadyImported ? (
                  <Badge variant="secondary" className="shrink-0">
                    已导入
                  </Badge>
                ) : null}
              </div>
            </div>
          )}
        </div>

        {/* footer */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border px-4 py-3">
          <AutofetchToggle
            checked={autofetch.enabled}
            onChange={autofetch.setEnabled}
            disabled={busy || importedCount > 0}
            count={importedCount > 0 ? 0 : 1}
          />
          <div className="flex items-center gap-2">
            {importedCount > 0 ? null : (
              <Button variant="outline" onClick={onClose} disabled={busy}>
                取消
              </Button>
            )}
            {importedCount > 0 ? (
              <Button onClick={onClose} disabled={busy}>
                完成
              </Button>
            ) : (
              <Button
                onClick={() => void runImport()}
                loading={importing}
                disabled={busy || !candidate || title.trim().length === 0}
              >
                导入
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
