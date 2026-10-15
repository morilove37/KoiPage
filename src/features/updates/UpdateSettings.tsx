import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";
import { cn } from "@/lib/utils";
import { checkForUpdates, loadUpdatePreference, setAutomaticUpdates, useUpdateStore } from "@/lib/updater";

export function UpdateSettings() {
  const state = useUpdateStore();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = ["checking", "downloading", "installing"].includes(state.status);
  useEffect(() => { void loadUpdatePreference().catch(() => setError("无法读取更新设置，请重新进入本页重试。")); }, []);
  async function toggle() {
    setSaving(true); setError(null);
    try { await setAutomaticUpdates(!state.automatic); }
    catch { setError("更新设置保存失败，请重试。" ); }
    finally { setSaving(false); }
  }
  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4" data-update-settings>
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 id="automatic-update-label" className="text-sm font-medium">启动时检查更新</h3>
          <p className="mt-1 text-xs text-muted-foreground">发现新版时提醒，确认后才下载并安装。</p>
        </div>
        <button type="button" role="switch" aria-checked={state.automatic} aria-labelledby="automatic-update-label"
          disabled={!state.preferenceLoaded || saving} onClick={() => void toggle()}
          className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50", state.automatic ? "bg-primary" : "bg-muted-foreground/40")}>
          <span className={cn("inline-block h-4 w-4 rounded-full bg-white transition-transform", state.automatic ? "translate-x-6" : "translate-x-1")} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" loading={state.status === "checking"} disabled={busy} onClick={() => void checkForUpdates()}>检查更新</Button>
        <Button variant="ghost" onClick={() => void openUrl(BRAND.releasesUrl).catch(() => setError("无法打开浏览器，请访问 GitHub 的 KoiPage Releases 页面。"))}>版本发布页 ↗</Button>
      </div>
      {state.status === "latest" ? <p role="status" className="text-xs text-muted-foreground">当前已是最新版本。</p> : null}
      {state.version && !state.dialogOpen && !busy ? <p className="text-xs text-muted-foreground">可更新到 {state.version}。<button className="ml-1 text-primary underline" onClick={() => useUpdateStore.setState({ dialogOpen: true })}>查看更新</button></p> : null}
      {error || state.error ? <p role="alert" className="text-xs text-destructive">{error || state.error}</p> : null}
    </div>
  );
}
