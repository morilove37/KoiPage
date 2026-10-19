import { invoke, isTauri } from "@tauri-apps/api/core";
import { initDatabase } from "@/lib/db";
import { coverSrc } from "@/lib/asset";
import { formatRating } from "@/lib/rating";
import { formatPlayTime, GAME_STATUS_LABELS } from "@/types/game";
import type { Game } from "@/types/game";
import replacementCover from "@/assets/share-cover-placeholder.jpg";
import { sharePages } from "./model";
import { loadCoverPreferences, useCoverStore } from '@/features/covers/store';
import { DEFAULT_COVER, effectiveCoverPath } from '@/features/covers/model';

export { replacementCover };
export interface ShareRender { pages: Blob[]; missing: string[] }

async function thumbnail(blob: Blob, censored: boolean): Promise<ImageBitmap> {
  const url = URL.createObjectURL(blob), image = new Image();
  const canvas = document.createElement("canvas");
  try {
    image.src = url;
    await image.decode();
    const scale = Math.min(220 / image.naturalWidth, 360 / image.naturalHeight, 1);
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法生成封面缩略图");
    if (censored) {
      ctx.filter = 'blur(14px)';
      ctx.drawImage(image, -16, -16, canvas.width + 32, canvas.height + 32);
    } else ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await createImageBitmap(canvas);
  } finally { URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0; }
}

/** Small decoded thumbnails are reused when sorting or editing the sheet. */
export class ShareCoverCache {
  private images = new Map<string, Promise<ImageBitmap>>();
  private disposed = false;
  async get(game: Game, replaced: boolean): Promise<ImageBitmap | null> {
    await loadCoverPreferences();
    const preferences = useCoverStore.getState().preferences[game.id] ?? DEFAULT_COVER;
    const censored = !replaced && preferences.censored;
    const source = replaced ? replacementCover : effectiveCoverPath(game.coverPath, preferences);
    if (!source) return Promise.resolve(null);
    const key = replaced ? "replacement" : `${game.id}:${source}:${censored}`;
    const previous = this.images.get(key);
    if (previous) return previous;
    const image = (async () => {
      let blob: Blob;
      if (!replaced && isTauri() && !source.startsWith("data:") && !source.startsWith("blob:")) {
        await initDatabase();
        const bytes = await invoke<ArrayBuffer>("share_cover_read", { gameId: game.id });
        blob = new Blob([bytes]);
      } else {
        const response = await fetch(replaced ? source : coverSrc(source)!);
        if (!response.ok) throw new Error("封面读取失败");
        blob = await response.blob();
      }
      const decoded = await thumbnail(blob, censored);
      if (this.disposed) { decoded.close(); throw new Error("分享窗口已关闭"); }
      return decoded;
    })().catch(error => { this.images.delete(key); throw error; });
    this.images.set(key, image);
    return image;
  }
  close() {
    this.disposed = true;
    for (const image of this.images.values()) void image.then(bitmap => bitmap.close()).catch(() => {});
    this.images.clear();
  }
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number, color: string) {
  ctx.fillStyle = color; ctx.beginPath(); ctx.roundRect(x, y, width, height, radius); ctx.fill();
}

function fitText(ctx: CanvasRenderingContext2D, text: string, width: number): string {
  if (ctx.measureText(text).width <= width) return text;
  const chars = Array.from(text);
  while (chars.length && ctx.measureText(chars.join("") + "…").width > width) chars.pop();
  return chars.join("") + "…";
}

function titleLines(ctx: CanvasRenderingContext2D, text: string, width: number): string[] {
  const chars = Array.from(text.replace(/\s+/g, " "));
  let line = "", index = 0;
  while (index < chars.length && ctx.measureText(line + chars[index]).width <= width) line += chars[index++];
  return index === chars.length ? [line] : [line, fitText(ctx, chars.slice(index).join(""), width)];
}

function drawCover(ctx: CanvasRenderingContext2D, image: ImageBitmap, x: number, y: number, w: number, h: number, contain: boolean) {
  const scale = contain ? Math.min(w / image.width, h / image.height) : Math.max(w / image.width, h / image.height);
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, [14, 14, 0, 0]); ctx.clip();
  ctx.drawImage(image, x + (w - image.width * scale) / 2, y + (h - image.height * scale) / 2, image.width * scale, image.height * scale);
  ctx.restore();
}

/** Export and upload receive these exact PNGs, never raw game objects. */
export async function renderShare(games: readonly Game[], replaced: ReadonlySet<number>, cache: ShareCoverCache, signal: AbortSignal): Promise<ShareRender> {
  await document.fonts.ready;
  const pages: Blob[] = [], missing = new Set<string>();
  const groups = sharePages(games);
  const columns = Math.max(1, Math.min(6, games.length)), pad = 48, gap = 20;
  const width = columns <= 2 ? 840 : columns === 3 ? 960 : columns === 4 ? 1120 : 1320;
  const cardWidth = Math.min(360, (width - pad * 2 - gap * (columns - 1)) / columns);
  const coverHeight = Math.round(cardWidth * 4 / 3), cardHeight = coverHeight + 148, rowGap = 28, header = 250;
  const date = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
  for (let page = 0; page < groups.length; page++) {
    signal.throwIfAborted();
    const group = groups[page], rows = Math.ceil(group.length / columns);
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = header + rows * cardHeight + (rows - 1) * rowGap + 96;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法创建分享图片，请重试。");
      ctx.fillStyle = "#111018"; ctx.fillRect(0, 0, width, canvas.height);
      const glow = ctx.createLinearGradient(0, 0, width, header);
      glow.addColorStop(0, "#30243f"); glow.addColorStop(1, "#15131e");
      ctx.fillStyle = glow; ctx.fillRect(0, 0, width, header - 12);
      ctx.font = '600 16px "Microsoft YaHei", sans-serif'; ctx.fillStyle = "#c7a5f2";
      ctx.fillText("KOIPAGE  /  GALGAME COLLECTION", pad, 43);
      ctx.font = '600 44px "Microsoft YaHei", sans-serif'; ctx.fillStyle = "#fbf7ff";
      ctx.fillText("我的 Galgame 足迹", pad, 105);
      ctx.font = '20px "Microsoft YaHei", sans-serif'; ctx.fillStyle = "#c2b8ce";
      ctx.fillText("收藏相遇，续写下一页。", pad, 143);
      const stats = [`${games.length} 部游玩作品`, `累计 ${formatPlayTime(games.reduce((sum, game) => sum + game.playTimeSeconds, 0))}`, `${games.filter(game => game.status === "completed").length} 部已通关`];
      let statX = pad;
      ctx.font = '17px "Microsoft YaHei", sans-serif';
      for (const stat of stats) {
        const statWidth = ctx.measureText(stat).width + 28;
        box(ctx, statX, 172, statWidth, 36, 18, "#ffffff0d");
        ctx.fillStyle = "#e9dff4"; ctx.fillText(stat, statX + 14, 196); statX += statWidth + 12;
      }
      for (let start = 0; start < group.length; start += 4) {
        signal.throwIfAborted();
        const batch = await Promise.all(group.slice(start, start + 4).map(async game => {
          try { return await cache.get(game, replaced.has(game.id)); }
          catch { return null; }
        }));
        signal.throwIfAborted();
        batch.forEach((image, offset) => {
          const index = start + offset, game = group[index], masked = replaced.has(game.id);
          const row = Math.floor(index / columns), rowItems = Math.min(columns, group.length - row * columns);
          const rowLeft = (width - rowItems * cardWidth - (rowItems - 1) * gap) / 2;
          const x = rowLeft + index % columns * (cardWidth + gap), y = header + row * (cardHeight + rowGap);
          box(ctx, x, y, cardWidth, cardHeight, 14, "#211d2c");
          if (masked) box(ctx, x, y, cardWidth, coverHeight, 14, "#edd9df");
          if (image) drawCover(ctx, image, x, y, cardWidth, coverHeight, masked);
          else {
            missing.add(game.title);
            ctx.font = '18px "Microsoft YaHei", sans-serif'; ctx.fillStyle = "#a497b7";
            ctx.fillText(masked ? "替换图读取失败" : "暂无封面", x + 18, y + coverHeight / 2);
          }
          ctx.font = '600 21px "Microsoft YaHei", sans-serif'; ctx.fillStyle = "#faf5ff";
          titleLines(ctx, game.title, cardWidth - 24).forEach((line, lineIndex) => ctx.fillText(line, x + 12, y + coverHeight + 27 + lineIndex * 25));
          if (game.originalTitle?.trim()) {
            ctx.font = '15px "Microsoft YaHei", sans-serif'; ctx.fillStyle = "#b4a7c4";
            titleLines(ctx, game.originalTitle.trim(), cardWidth - 24).forEach((line, lineIndex) => ctx.fillText(line, x + 12, y + coverHeight + 75 + lineIndex * 18));
          }
          ctx.font = '14px "Microsoft YaHei", sans-serif'; ctx.fillStyle = "#b4a7c4";
          ctx.fillText(GAME_STATUS_LABELS[game.status], x + 12, y + coverHeight + 116);
          const rating = game.rating === null ? "暂无评分" : `评分 ${formatRating(game.rating)}`;
          ctx.fillStyle = "#d6b4ff";
          ctx.fillText(rating, x + cardWidth - 12 - ctx.measureText(rating).width, y + coverHeight + 116);
          ctx.fillStyle = "#b4a7c4";
          ctx.fillText(fitText(ctx, `游玩 ${formatPlayTime(game.playTimeSeconds)}`, cardWidth - 24), x + 12, y + cardHeight - 10);
        });
      }
      const footerY = canvas.height - 51;
      ctx.fillStyle = "#332b40"; ctx.fillRect(pad, footerY - 18, width - pad * 2, 1);
      ctx.font = '16px "Microsoft YaHei", sans-serif'; ctx.fillStyle = "#a99bb9";
      ctx.fillText("恋页 KoiPage · 我的故事收藏", pad, footerY + 13);
      const footer = `${date}  ·  ${page + 1} / ${groups.length}`;
      ctx.fillText(footer, width - pad - ctx.measureText(footer).width, footerY + 13);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("分享图片生成失败")), "image/png"));
      signal.throwIfAborted(); pages.push(blob);
    } finally { canvas.width = 0; canvas.height = 0; }
  }
  return { pages, missing: [...missing] };
}
