/**
 * Drag-and-drop archive import for the scan dialog.
 *
 * Dropping `.zip` / `.rar` / `.7z` files (including split volumes) starts
 * extraction into a user-selectable folder — defaulting to the first scan root.
 * Password-protected archives pause here and ask for the password, then retry.
 * Every successful extraction reports its folder back so the scan dialog can
 * immediately look for launch files inside it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ARCHIVE_EXTRACT_PROGRESS_EVENT,
  archiveExtract,
  archiveGroup,
} from "@/lib/db";
import type { ArchiveExtractResult, ArchiveGroup, ArchiveExtractProgress } from "@/lib/db";

interface ArchiveImportPanelProps {
  /** Default extraction folder, normally the first configured scan root. */
  defaultDestination: string;
  /** True while the parent is scanning/importing; drops are ignored. */
  disabled?: boolean;
  onBusyChange: (busy: boolean) => void;
  /** Called with each successfully extracted folder. */
  onExtracted: (roots: string[]) => void;
}

type RowStatus = "queued" | "extracting" | "done" | "failed" | "skipped";

interface ExtractRow {
  group: ArchiveGroup;
  status: RowStatus;
  percent: number;
  message: string | null;
  targetDir: string | null;
}

type PasswordOutcome = ArchiveExtractResult | { status: "skipped" };

const ARCHIVE_EXTENSIONS = [
  "zip", "rar", "7z", "001", "002", "003", "004", "005",
  "z01", "z02", "z03", "z04", "z05",
  "r00", "r01", "r02", "r03", "r04", "r05",
];

function rowLabel(row: ExtractRow): string {
  switch (row.status) {
    case "queued": return "等待解压";
    case "extracting": return `解压中 ${row.percent}%`;
    case "done": return "解压完成";
    case "skipped": return "已跳过";
    case "failed": return "解压失败";
  }
}

export function ArchiveImportPanel({
  defaultDestination,
  disabled = false,
  onBusyChange,
  onExtracted,
}: ArchiveImportPanelProps) {
  const [destination, setDestination] = useState(defaultDestination);
  const [rows, setRows] = useState<ExtractRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{ index: number; wrong: boolean } | null>(null);
  const [passwordInput, setPasswordInput] = useState("");
  const [recycle, setRecycle] = useState<{ files: number; warning: string | null } | null>(null);

  const alive = useRef(true);
  const passwordResolver = useRef<((value: string | null) => void) | null>(null);
  const pendingGroups = useRef<ArchiveGroup[] | null>(null);
  const destinationTouched = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      passwordResolver.current?.(null);
    };
  }, []);

  // The scan roots are loaded asynchronously by the parent; adopt the first one
  // as the default destination until the user picks something else.
  useEffect(() => {
    if (!destinationTouched.current && defaultDestination) {
      setDestination(defaultDestination);
    }
  }, [defaultDestination]);

  useEffect(() => {
    onBusyChange(busy);
  }, [busy, onBusyChange]);

  const updateRow = useCallback((index: number, patch: Partial<ExtractRow>) => {
    setRows((previous) =>
      previous.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  }, []);

  const promptPassword = useCallback((index: number, wrong: boolean) => {
    return new Promise<string | null>((resolve) => {
      passwordResolver.current = resolve;
      setPasswordInput("");
      setPrompt({ index, wrong });
    });
  }, []);

  const extractOne = useCallback(async (
    group: ArchiveGroup,
    index: number,
    root: string,
  ): Promise<PasswordOutcome> => {
    let password = "";
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const result = await archiveExtract(group.primary, root, password || undefined);
      if (!alive.current) return { status: "skipped" };
      if (result.status !== "passwordRequired" && result.status !== "wrongPassword") {
        return result;
      }
      const entered = await promptPassword(index, result.status === "wrongPassword");
      if (entered === null) return { status: "skipped" };
      password = entered;
    }
    return {
      status: "failed",
      archive: group.primary,
      targetDir: "",
      message: "密码尝试次数过多，已跳过。",
      deletedFiles: [],
      cleanupWarning: null,
    };
  }, [promptPassword]);

  const runExtraction = useCallback(async (groups: ArchiveGroup[], destinationOverride?: string) => {
    if (groups.length === 0) return;
    const root = (destinationOverride ?? destination).trim();
    if (!root) {
      pendingGroups.current = groups;
      setError("请先选择解压目录。");
      return;
    }
    pendingGroups.current = null;
    setError(null);
    setRecycle(null);
    setRows(groups.map((group) => ({
      group, status: "queued", percent: 0, message: null, targetDir: null,
    })));
    setBusy(true);
    const extracted: string[] = [];
    let recycledFiles = 0;
    let cleanupWarning: string | null = null;
    try {
      for (let index = 0; index < groups.length; index += 1) {
        if (!alive.current) return;
        updateRow(index, { status: "extracting", percent: 0 });
        const result = await extractOne(groups[index], index, root);
        if (!alive.current) return;
        if (result.status === "ok") {
          extracted.push(result.targetDir);
          recycledFiles += result.deletedFiles?.length ?? 0;
          if (result.cleanupWarning) cleanupWarning = result.cleanupWarning;
          updateRow(index, { status: "done", percent: 100, targetDir: result.targetDir });
        } else if (result.status === "skipped") {
          updateRow(index, { status: "skipped" });
        } else {
          updateRow(index, {
            status: "failed",
            message: result.message ?? "解压失败",
          });
        }
      }
    } catch (cause) {
      setError(`解压失败：${String(cause)}`);
    } finally {
      if (alive.current) {
        if (recycledFiles > 0 || cleanupWarning !== null) {
          setRecycle({ files: recycledFiles, warning: cleanupWarning });
        }
        setBusy(false);
        if (extracted.length > 0) onExtracted(extracted);
      }
    }
  }, [destination, extractOne, onExtracted, updateRow]);

  const handlePaths = useCallback(async (paths: string[]) => {
    if (disabled || busy) return;
    setError(null);
    try {
      const groups = await archiveGroup(paths);
      if (!alive.current) return;
      if (groups.length === 0) {
        setError("没有识别到支持的压缩包（支持 .zip / .rar / .7z 及常见分卷）。");
        return;
      }
      await runExtraction(groups);
    } catch (cause) {
      if (alive.current) setError(`读取压缩包失败：${String(cause)}`);
    }
  }, [busy, disabled, runExtraction]);

  // Tauri delivers OS file drops as webview events, not HTML5 drop events.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          if (!disabled && !busy) setDragging(true);
          return;
        }
        if (payload.type === "leave") {
          setDragging(false);
          return;
        }
        setDragging(false);
        if (payload.type === "drop") void handlePaths(payload.paths);
      })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((cause) => {
        console.warn("[archive] drag-drop listener:", cause);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [busy, disabled, handlePaths]);

  // Per-archive progress events.
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<ArchiveExtractProgress>(ARCHIVE_EXTRACT_PROGRESS_EVENT, (event) => {
      setRows((previous) =>
        previous.map((row) =>
          row.group.primary === event.payload.archive
            ? { ...row, percent: event.payload.percent }
            : row,
        ),
      );
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const pickArchives = useCallback(async () => {
    setError(null);
    try {
      const selected = await open({
        title: "选择一个或多个压缩包",
        multiple: true,
        filters: [{ name: "压缩包", extensions: ARCHIVE_EXTENSIONS }],
      });
      if (selected === null) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await handlePaths(paths);
    } catch (cause) {
      setError(`无法打开文件选择对话框：${String(cause)}`);
    }
  }, [handlePaths]);

  const pickDestination = useCallback(async () => {
    setError(null);
    try {
      const selected = await open({ title: "选择解压目录", directory: true });
      if (typeof selected !== "string" || selected.length === 0) return;
      destinationTouched.current = true;
      setDestination(selected);
      if (pendingGroups.current !== null) {
        const groups = pendingGroups.current;
        pendingGroups.current = null;
        await runExtraction(groups, selected);
      }
    } catch (cause) {
      setError(`无法选择目录：${String(cause)}`);
    }
  }, [runExtraction]);

  function submitPassword() {
    const value = passwordInput.trim();
    if (!value || prompt === null) return;
    const resolve = passwordResolver.current;
    passwordResolver.current = null;
    setPrompt(null);
    resolve?.(value);
  }

  function skipPassword() {
    if (prompt === null) return;
    const resolve = passwordResolver.current;
    passwordResolver.current = null;
    setPrompt(null);
    resolve?.(null);
  }

  return (
    <section className="border-b border-border bg-muted/20 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-medium">从压缩包导入</p>
        <span className="text-[11px] text-muted-foreground">
          支持 .zip / .rar / .7z 及分卷
        </span>
      </div>

      <div
        className={cn(
          "mt-2 flex flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed px-3 py-4 text-center text-xs transition-colors",
          dragging
            ? "border-primary bg-primary/5 text-foreground"
            : "border-border text-muted-foreground",
          (disabled || busy) && "opacity-60",
        )}
      >
        <p>{dragging ? "松手开始解压" : "把压缩包直接拖到这里"}</p>
        <Button size="sm" variant="outline" disabled={disabled || busy} onClick={() => void pickArchives()}>
          选择压缩包…
        </Button>
        <p className="text-[11px] leading-relaxed">
          分卷只需拖入任意一卷；解压出的文件夹会自动扫描启动文件。
        </p>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="shrink-0 text-muted-foreground">解压到</span>
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          title={destination || undefined}
        >
          {destination || "未设置（请选择目录）"}
        </span>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void pickDestination()}>
          更改目录…
        </Button>
      </div>

      {rows.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs">
          {rows.map((row, index) => (
            <li key={row.group.primary} className="flex items-start justify-between gap-2">
              <span className="min-w-0 break-words font-medium">{row.group.displayName}</span>
              <span
                className={cn(
                  "shrink-0 text-right",
                  row.status === "failed" ? "text-destructive" : "text-muted-foreground",
                  row.status === "done" && "text-emerald-600 dark:text-emerald-500",
                )}
                title={row.message ?? row.targetDir ?? undefined}
              >
                {rowLabel(row)}
                {row.status === "failed" && row.message ? `：${row.message}` : ""}
              </span>
              {prompt?.index === index ? <span className="sr-only">等待密码</span> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {recycle ? (
        <div className="mt-2 space-y-0.5 text-xs leading-relaxed">
          {recycle.files > 0 ? (
            <p className="text-muted-foreground">
              已解压并清理原压缩包（{recycle.files} 个文件已移入回收站）。如需恢复原文件，请前往回收站还原。
            </p>
          ) : null}
          {recycle.warning ? <p className="text-destructive">{recycle.warning}</p> : null}
        </div>
      ) : null}

      {prompt !== null ? (
        <div className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          <p>
            压缩包「{rows[prompt.index]?.group.displayName ?? ""}」
            {prompt.wrong ? "密码错误，请重新输入。" : "需要密码才能解压。"}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Input
              type="password"
              autoFocus
              value={passwordInput}
              onChange={(event) => setPasswordInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  submitPassword();
                }
              }}
              placeholder="输入压缩包密码"
              className="h-8 min-w-0 flex-1"
              aria-label="压缩包密码"
            />
            <Button size="sm" disabled={!passwordInput.trim()} onClick={submitPassword}>
              继续解压
            </Button>
            <Button size="sm" variant="ghost" onClick={skipPassword}>
              跳过
            </Button>
          </div>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="mt-2 text-xs text-destructive">{error}</p>
      ) : null}
    </section>
  );
}
