import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { settingsGet, settingsSet } from "@/lib/db";
import { cn } from "@/lib/utils";
import { errorMessage, localeToolStatus } from "@/features/io/io";
import type { LocaleToolStatus } from "@/features/io/io";

export function LocaleToolSection() {
  const [source, setSource] = useState<"bundled" | "custom">("bundled");
  const [enabled, setEnabled] = useState(false);
  const [toolPath, setToolPath] = useState("");
  const [status, setStatus] = useState<LocaleToolStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toolError, setToolError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      Promise.all([settingsGet("locale_tool_use"), settingsGet("locale_tool_source"), settingsGet("locale_tool_path")]).then(([use, selected, path]) => {
        if (cancelled) return;
        setEnabled(["1", "true", "yes", "on"].includes(use?.trim().toLowerCase() ?? ""));
        setSource(selected === "custom" ? "custom" : "bundled"); setToolPath(path ?? "");
      }),
      localeToolStatus().then(next => { if (!cancelled) setStatus(next); }).catch(cause => { if (!cancelled) setToolError(errorMessage(cause)); }),
    ]).catch(cause => { if (!cancelled) setError(errorMessage(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function saveSetting(key: string, value: string, apply: () => void, message: string) {
    if (loading || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try { await settingsSet(key, value); apply(); setNotice(message); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function chooseTool() {
    if (loading || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const path = await open({ multiple: false, directory: false, title: "选择其他转区工具", filters: [{ name: "可执行文件", extensions: ["exe", "bat", "cmd"] }] });
      if (typeof path !== "string") return;
      await settingsSet("locale_tool_path", path); setToolPath(path); setNotice("已保存其他转区工具路径。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function checkTool() {
    setBusy(true); setToolError(null);
    try { setStatus(await localeToolStatus()); }
    catch (cause) { setToolError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  const ready = source === "bundled" ? status?.available === true : toolPath.trim().length > 0;
  return <div data-locale-launch-settings className="space-y-4">
    <div className="flex items-center justify-between gap-4">
      <div>
        <h3 id="locale-launch-label" className="text-sm font-medium">启用转区</h3>
        <p className="mt-1 text-xs text-muted-foreground">开启后使用日文区域环境启动游戏；关闭后正常启动。</p>
      </div>
      <button type="button" role="switch" aria-labelledby="locale-launch-label" aria-checked={enabled}
        disabled={loading || busy || (!enabled && !ready)}
        onClick={() => void saveSetting("locale_tool_use", enabled ? "0" : "1", () => setEnabled(!enabled), enabled ? "转区启动已关闭。" : "转区启动已开启。")}
        className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50", enabled ? "bg-primary" : "bg-muted-foreground/40")}>
        <span className={cn("inline-block h-4 w-4 rounded-full bg-white transition-transform", enabled ? "translate-x-6" : "translate-x-1")} />
      </button>
    </div>
    <div className="max-w-sm space-y-1.5">
      <label htmlFor="locale-source" className="text-xs font-medium text-muted-foreground">转区工具</label>
      <Select id="locale-source" aria-label="转区工具" value={source} disabled={loading || busy}
        options={[{ value: "bundled", label: "内置 Locale Emulator（推荐）" }, { value: "custom", label: "其他转区工具" }]}
        onValueChange={value => void saveSetting("locale_tool_source", value, () => setSource(value), "已切换转区工具。")} />
    </div>
    {source === "bundled" ? <div className="space-y-2 rounded-lg border border-border bg-primary/5 p-3">
      <p className="text-sm font-medium">内置 Locale Emulator {status?.version ?? "2.5.0.1"}</p>
      <p className="text-xs text-muted-foreground">{loading ? "正在准备内置 LE…" : status?.available ? "已就绪，无需选择工具路径，可离线使用。" : "内置 LE 暂不可用，请重新检查。"}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">适用于 32 位日文游戏，使用日语区域、日文代码页 932 和日本时区。内置 LE 按游戏 exe 所在目录启动；64 位游戏请关闭转区启动。</p>
      {toolError ? <p role="alert" className="text-xs text-destructive">{toolError}</p> : null}
      {!loading && !status?.available ? <Button variant="outline" size="sm" loading={busy} onClick={() => void checkTool()}>重新检查内置 LE</Button> : null}
    </div> : <div className="space-y-2">
      <div className="flex items-center gap-2"><input readOnly aria-label="其他转区工具路径" value={toolPath} placeholder="选择其他转区工具的可执行文件" className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-xs text-muted-foreground" /><Button variant="outline" disabled={loading || busy} onClick={() => void chooseTool()}>选择工具</Button></div>
      <p className="text-xs text-muted-foreground">LEProc 会识别其自有配置；其他工具沿用「工具 + 游戏程序 + 游戏参数」的调用方式。</p>
    </div>}
    {notice ? <p role="status" className="text-sm text-emerald-500">{notice}</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </div>;
}
