import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { CoverImage } from "@/components/ui/cover-image";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { LabeledSelect } from "@/components/ui/select";
import { errorMessage } from "@/features/io/io";
import { formatPlayTime, GAME_STATUS_LABELS } from "@/types/game";
import type { Game } from "@/types/game";
import { hasPlayed, shareGames, SHARE_SORTS } from "./model";
import type { ShareDirection, ShareSort } from "./model";
import { renderShare, replacementCover, ShareCoverCache } from "./render";
import { copyShareImage, copyShareLinks, saveShare, uploadShareImages } from "./io";
import { loadCoverPreferences, useCoverStore } from '@/features/covers/store';

interface Artifact { key: string; pages: Blob[]; urls: string[]; missing: string[] }
type Action = "save" | "copy" | "upload" | "links";

export default function ShareDialog({ games, onClose }: { games: Game[]; onClose: () => void }) {
  const coverPreferences = useCoverStore(state => state.preferences);
  const coversLoaded = useCoverStore(state => state.loaded);
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [replaced, setReplaced] = useState<Set<number>>(() => new Set());
  const [sort, setSort] = useState<ShareSort>("lastPlayedAt");
  const [direction, setDirection] = useState<ShareDirection>("desc");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [generating, setGenerating] = useState(true);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<Action | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<Array<string | null>>([]);
  const cache = useRef<ShareCoverCache | null>(null);
  // Immediate guard also prevents double clicks before React paints `busy`.
  const actionRunning = useRef(false);

  const played = useMemo(() => games.filter(hasPlayed), [games]);
  const visible = useMemo(() => shareGames(games, hidden, sort, direction), [games, hidden, sort, direction]);
  const listed = useMemo(() => shareGames(games, new Set(), sort, direction).filter(game => [game.title, game.originalTitle].some(title => title?.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))), [games, sort, direction, search]);
  const composition = useMemo(() => JSON.stringify([coversLoaded, visible.map(game => [game.id, game.title, game.originalTitle, game.status, game.rating, game.playTimeSeconds, replaced.has(game.id) ? "replacement" : [game.coverPath, coverPreferences[game.id]]])]), [visible, replaced, coversLoaded, coverPreferences]);
  const current = artifact?.key === composition ? artifact : null;
  const pageIndex = Math.min(page, Math.max(0, (current?.pages.length ?? 1) - 1));
  const ready = Boolean(current?.pages.length) && !generating && !busy;

  useEffect(() => {
    void loadCoverPreferences().catch(cause => setError(errorMessage(cause)));
    const next = new ShareCoverCache(); cache.current = next;
    return () => { next.close(); cache.current = null; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let urls: string[] = [];
    setGenerating(true); setError(null); setMessage(null); setLinks([]); setPage(0);
    const timer = window.setTimeout(() => {
      const images = cache.current;
      if (!images) return;
      void renderShare(visible, replaced, images, controller.signal).then(result => {
        if (controller.signal.aborted) return;
        urls = result.pages.map(blob => URL.createObjectURL(blob));
        setArtifact({ key: composition, ...result, urls });
      }).catch(cause => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      }).finally(() => { if (!controller.signal.aborted) setGenerating(false); });
    }, 160);
    return () => { controller.abort(); window.clearTimeout(timer); urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [composition, retry, visible, replaced]);

  const toggle = (id: number, setter: (update: (before: Set<number>) => Set<number>) => void) => {
    setter(before => { const next = new Set(before); if (!next.delete(id)) next.add(id); return next; });
  };

  async function act(action: Action) {
    if (!ready || !current || actionRunning.current) return;
    actionRunning.current = true; setBusy(action); setError(null); setMessage(null);
    try {
      if (action === "save") {
        if (await saveShare(current.pages)) setMessage(`已保存 ${current.pages.length} 张分享图片。`);
      } else if (action === "copy") {
        await copyShareImage(current.pages[pageIndex]); setMessage(`第 ${pageIndex + 1} 张图片已复制，可以粘贴到 QQ 等应用。`);
      } else if (action === "links") {
        await copyShareLinks(links.filter((link): link is string => Boolean(link))); setMessage("分享链接已复制。");
      } else {
        setMessage(`正在上传 ${current.pages.length} 张图片并创建分享页面…`);
        setLinks([await uploadShareImages(current.pages)]);
        setMessage("链接已生成，24 小时后失效。点击复制链接即可分享。");
      }
    } catch (cause) { setError(errorMessage(cause)); setMessage(null); }
    finally { actionRunning.current = false; setBusy(null); }
  }

  const linkCount = links.filter(Boolean).length;
  return (
    <Dialog open onClose={() => { if (!actionRunning.current) onClose(); }} title="分享我的 Galgame 足迹"
      description="生成游玩作品分享图，或创建 24 小时临时链接。隐藏与替换封面只作用于本次分享。"
      className="max-w-6xl"
      footer={<>
        <Button variant="ghost" disabled={Boolean(busy)} onClick={onClose}>关闭</Button>
        <Button variant="outline" disabled={!ready} loading={busy === "save"} onClick={() => void act("save")}>{(current?.pages.length ?? 0) > 1 ? "保存全部图片" : "保存图片"}</Button>
        <Button variant="outline" disabled={!ready} loading={busy === "copy"} onClick={() => void act("copy")}>{(current?.pages.length ?? 0) > 1 ? "复制本页图片" : "复制图片"}</Button>
        <Button disabled={!ready} loading={busy === "upload"} onClick={() => void act(linkCount ? "links" : "upload")}>{linkCount ? "复制分享链接" : "生成24小时链接"}</Button>
      </>}>
      <div className="grid gap-4 md:grid-cols-[minmax(250px,0.85fr)_minmax(0,1.15fr)]" data-share-editor>
        <div className="flex min-w-0 flex-col gap-3">
          <fieldset disabled={Boolean(busy)} className="flex min-w-0 flex-col gap-3 disabled:opacity-70">
            <div className="grid grid-cols-[1fr_auto] items-end gap-2">
              <LabeledSelect label="分享排序" options={SHARE_SORTS} value={sort} onValueChange={value => { setSort(value); setDirection(value === "title" ? "asc" : "desc"); }} />
              <Button variant="outline" onClick={() => setDirection(value => value === "desc" ? "asc" : "desc")}>{direction === "desc" ? "降序 ↓" : "升序 ↑"}</Button>
            </div>
            <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/30 p-2.5">
              <img src={replacementCover} alt="分享时使用的替换封面" className="h-12 w-16 rounded object-cover" />
              <div className="text-xs"><p className="font-medium">统一替换封面</p><p className="mt-1 text-muted-foreground">勾选指定作品后，使用这张图片。</p></div>
            </div>
            <Input aria-label="搜索分享列表" placeholder="搜索游玩作品，不改变分享范围" value={search} onChange={event => setSearch(event.target.value)} />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span className="mr-auto text-muted-foreground">展示 {visible.length} / {played.length} 部</span>
              <button type="button" className="text-primary hover:underline" onClick={() => setHidden(new Set())}>全部展示</button>
              <button type="button" className="text-primary hover:underline" onClick={() => setHidden(new Set(played.map(game => game.id)))}>全部隐藏</button>
              <button type="button" className="text-primary hover:underline" onClick={() => setReplaced(new Set())}>还原封面</button>
            </div>
            <div className="max-h-[36vh] min-h-28 overflow-y-auto rounded-lg border border-border" data-share-list>
              {listed.length ? listed.map(game => (
                <div key={game.id} className={`flex items-center gap-2.5 border-b border-border p-2.5 last:border-0 ${hidden.has(game.id) ? "bg-muted/30" : ""}`} data-share-game-id={game.id}>
                  <div className="h-12 w-9 shrink-0 overflow-hidden rounded bg-muted">
                    {replaced.has(game.id) ? <img src={replacementCover} alt="已替换封面" className="h-full w-full object-contain" /> : <CoverImage gameId={game.id} path={game.coverPath} alt="" className="h-full w-full object-cover" fallbackText="" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium" title={game.title}>{game.title}</p>
                    {game.originalTitle?.trim() ? <p className="mt-0.5 line-clamp-2 break-words text-[11px] text-muted-foreground" title={game.originalTitle}>{game.originalTitle}</p> : null}
                    <p className="mt-1 text-[11px] text-muted-foreground">{GAME_STATUS_LABELS[game.status]}{hidden.has(game.id) ? " · 本次隐藏" : ""}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">游玩 {formatPlayTime(game.playTimeSeconds)}</p>
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5 text-[11px]">
                    <label className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" aria-label={`展示 ${game.title}`} checked={!hidden.has(game.id)} onChange={() => toggle(game.id, setHidden)} className="accent-primary" />展示</label>
                    <label className="flex cursor-pointer items-center gap-1.5"><input type="checkbox" aria-label={`替换封面 ${game.title}`} disabled={hidden.has(game.id)} checked={replaced.has(game.id)} onChange={() => toggle(game.id, setReplaced)} className="accent-primary" />换封面</label>
                  </div>
                </div>
              )) : <p className="p-4 text-xs text-muted-foreground">{played.length ? "没有匹配的游玩作品。" : "还没有游玩过的作品。启动游戏或在详情中记录游玩状态后再来分享。"}</p>}
            </div>
          </fieldset>
          <p className="text-[11px] leading-relaxed text-muted-foreground">链接由 beacon.host 匿名公开托管 24 小时，拿到链接的人可查看全部分享图。仅点击生成链接时上传图片；服务有发布频率限制。</p>
        </div>
        <div className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between gap-2 text-xs">
            <span className="font-medium">分享预览</span>
            {current && current.pages.length > 1 ? <div className="flex items-center gap-2">
              <button type="button" disabled={pageIndex === 0 || Boolean(busy)} onClick={() => setPage(index => index - 1)} className="disabled:opacity-30">上一张</button>
              <span>{pageIndex + 1} / {current.pages.length}</span>
              <button type="button" disabled={pageIndex === current.pages.length - 1 || Boolean(busy)} onClick={() => setPage(index => index + 1)} className="disabled:opacity-30">下一张</button>
            </div> : <span className="text-muted-foreground">每张最多 60 部，自动分页</span>}
          </div>
          <div className="flex h-[49vh] min-h-64 flex-col overflow-auto rounded-lg border border-border bg-muted/30 p-2" data-share-preview aria-busy={generating}>
            {generating ? <p role="status" className="m-auto py-10 text-xs text-muted-foreground">正在生成分享图片…</p>
              : current?.urls[pageIndex] ? <img src={current.urls[pageIndex]} alt={`游玩足迹分享图，第 ${pageIndex + 1} 张`} className="h-auto w-full shrink-0 rounded" />
                : <p className="m-auto p-5 text-center text-xs text-muted-foreground">{visible.length ? "预览未生成，请重试。" : "勾选至少一部作品后生成分享图。"}</p>}
          </div>
          {current?.missing.length ? <p className="text-[11px] text-muted-foreground">{current.missing.length} 部作品封面缺失或读取失败，分享图已使用文字占位。</p> : null}
          {message ? <p role="status" className="text-xs text-primary">{message}</p> : null}
          {error ? <div role="alert" className="text-xs text-destructive">{error} {!current && visible.length ? <button type="button" className="underline" onClick={() => setRetry(value => value + 1)}>重新生成</button> : null}</div> : null}
          {linkCount > 0 ? <div className="flex flex-col gap-2 rounded border border-border p-2.5 text-xs" data-share-links>
            {links.map((link, index) => link ? <a key={index} href={link} target="_blank" rel="noreferrer" className="break-all text-primary underline">分享页面：{link}</a> : null)}
            <Button size="sm" variant="outline" disabled={Boolean(busy) || !ready} onClick={() => void act("links")}>复制{linkCount > 1 ? "全部" : ""}链接</Button>
          </div> : null}
        </div>
      </div>
    </Dialog>
  );
}
