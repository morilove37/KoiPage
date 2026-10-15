import { useEffect } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { BRAND } from "@/lib/brand";
import { DEVELOPMENT_BUILD, dismissUpdate, installUpdate, scheduleStartupUpdateCheck, useUpdateStore } from "@/lib/updater";

export function UpdateDialog() {
  const state = useUpdateStore();
  useEffect(scheduleStartupUpdateCheck, []);
  const busy = state.status === "downloading" || state.status === "installing";
  const progress = state.total && state.total > 0 ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : null;
  return (
    <Dialog
      open={state.dialogOpen}
      onClose={dismissUpdate}
      title={`发现新版本 ${state.version ?? ""}`}
      description={`当前版本 ${BRAND.version}。安装前请保存当前修改并退出正在运行的游戏。`}
      footer={<>
        <Button variant="ghost" disabled={busy} onClick={dismissUpdate}>稍后提醒</Button>
        <Button disabled={busy} onClick={() => {
          if (DEVELOPMENT_BUILD) void openUrl(BRAND.releasesUrl).catch(() => {});
          else void installUpdate();
        }}>{DEVELOPMENT_BUILD ? "前往下载发布版" : state.status === "installing" ? "正在安装…" : state.status === "downloading" ? "正在下载…" : "下载并安装"}</Button>
      </>}
    >
      <div className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">更新说明</h3>
        <p className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{state.notes || "此版本包含功能改进与问题修复。"}</p>
        {DEVELOPMENT_BUILD ? <p className="text-xs text-muted-foreground">开发版仅检查更新，安装请使用 GitHub 发布的正式安装包。</p> : null}
        {busy ? <div role="status" className="space-y-2 text-xs text-muted-foreground">
          <p>{state.status === "installing" ? "正在安装，完成后将重新打开应用…" : `正在下载更新${progress === null ? `（${(state.downloaded / 1024 / 1024).toFixed(1)} MB）` : ` ${progress}%`}`}</p>
          <progress aria-label="更新下载进度" className="h-2 w-full accent-primary" max={100} value={progress ?? undefined} />
        </div> : null}
        {state.error ? <p role="alert" className="text-xs text-destructive">{state.error}</p> : null}
      </div>
    </Dialog>
  );
}
