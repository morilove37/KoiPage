import { Button } from "@/components/ui/button";
import { BRAND } from "@/lib/brand";
import { initializeAnnouncements, openAnnouncement, useAnnouncementStore } from "./store";

export function AnnouncementSettings() {
  const state = useAnnouncementStore();
  const disabled = !state.preferences || state.loading || state.saving;
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium">应用公告</p>
        <p className="mt-1 text-xs text-muted-foreground">{state.preferences ? state.preferences.welcomeDismissed ? "已关闭启动提醒。" : "启动时提醒。" : "正在读取提醒设置。"}</p>
      </div>
      <Button variant="outline" disabled={disabled} onClick={() => openAnnouncement("welcome")}>查看应用公告</Button>
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium">版本公告 · v{BRAND.version}</p>
      </div>
      <Button variant="outline" disabled={disabled} onClick={() => openAnnouncement("version")}>查看版本公告</Button>
    </div>
    {state.error ? <div className="flex flex-wrap items-center gap-3">
      <p role="alert" className="text-sm text-destructive">{state.error}</p>
      {!state.preferences ? <Button variant="outline" loading={state.loading} onClick={() => void initializeAnnouncements()}>重新读取</Button> : null}
    </div> : null}
  </div>;
}
