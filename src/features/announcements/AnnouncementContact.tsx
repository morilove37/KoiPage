import { isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { BRAND } from "@/lib/brand";
import { AnnouncementMascot } from "./AnnouncementMascot";

/** Project and author information shared by both notices. */
export function AnnouncementContact() {
  const [error, setError] = useState<string | null>(null);
  return <section aria-label="项目与作者" className="border-t border-border pt-4">
    <h3 className="text-sm font-semibold">项目与作者</h3>
    <div className="mt-3 flex items-start gap-3">
      <div className="min-w-0 flex-1 space-y-3 text-sm">
        <div>
          <p className="font-medium">GitHub 项目</p>
          <a href={BRAND.repositoryUrl} target="_blank" rel="noopener noreferrer"
            className="mt-1 inline-block break-all text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={event => {
              if (!isTauri()) return;
              event.preventDefault();
              setError(null);
              void openUrl(BRAND.repositoryUrl).catch(() => setError("无法打开浏览器，请复制上方项目地址后访问。"));
            }}>
            {BRAND.repositoryUrl} <span aria-hidden="true">↗</span>
          </a>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">查看源代码、下载新版本，或在 Issues 中反馈问题与建议。</p>
        </div>
        <div>
          <p className="font-medium">作者抖音 · 空苍若叶</p>
          <p className="mt-1 text-xs text-muted-foreground">抖音号：84398786679</p>
        </div>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      </div>
      <AnnouncementMascot />
    </div>
  </section>;
}
