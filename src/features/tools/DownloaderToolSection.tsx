import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Progress { id: string; downloaded: number; total: number }

function formatBytes(value: number) {
  if (!value) return "未知大小";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value; let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function DownloaderToolSection() {
  const urlId = useId();
  const [url, setUrl] = useState("");
  const [connections, setConnections] = useState(8);
  const [destination, setDestination] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | undefined;
    void listen<Progress>("download-progress", event => {
      if (alive && event.payload.id === "tools-download") setProgress(event.payload);
    }).then(stop => { if (alive) unlisten = stop; else stop(); });
    return () => { alive = false; unlisten?.(); };
  }, []);

  async function choosePath() {
    const picked = await save({ title: "选择下载保存位置", defaultPath: url.split(/[/?#]/).filter(Boolean).pop() || "download.bin" });
    if (picked) setDestination(picked);
  }

  async function startDownload() {
    if (!url.trim() || !destination) return;
    setBusy(true); setError(""); setProgress({ id: "tools-download", downloaded: 0, total: 0 });
    try {
      await invoke("download_file", { url: url.trim(), destination, connections, downloadId: "tools-download" });
      setProgress(current => current ? { ...current, downloaded: current.total || current.downloaded } : current);
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  const percentage = progress?.total ? Math.min(100, Math.floor(progress.downloaded / progress.total * 100)) : null;
  return (
    <div className="space-y-4">
      <div>
        <label htmlFor={urlId} className="mb-1.5 block text-sm font-medium">下载网址</label>
        <Input id={urlId} type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/game.zip" disabled={busy} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <label className="mb-1.5 block text-sm font-medium">保存文件</label>
          <div className="flex gap-2">
            <Input value={destination} onChange={event => setDestination(event.target.value)} placeholder="选择保存路径" disabled={busy} />
            <Button type="button" variant="outline" onClick={() => void choosePath()} disabled={busy}>浏览…</Button>
          </div>
        </div>
        <label className="text-sm">连接数
          <select aria-label="下载连接数" value={connections} onChange={event => setConnections(Number(event.target.value))} disabled={busy} className="ml-2 h-9 rounded-lg border border-border bg-background px-2">
            {[2, 4, 8, 12, 16].map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        </label>
        <Button onClick={() => void startDownload()} disabled={busy || !url.trim() || !destination} loading={busy}>开始下载</Button>
      </div>
      {progress ? <div aria-live="polite" className="space-y-1.5">
        <div className="flex justify-between gap-3 text-xs text-muted-foreground"><span>{busy ? "正在下载" : error ? "下载失败" : "下载完成"} · {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}</span><span>{percentage === null ? "" : `${percentage}%`}</span></div>
        <progress aria-label="下载进度" className="h-2 w-full accent-primary" max={100} value={percentage ?? undefined} />
      </div> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
