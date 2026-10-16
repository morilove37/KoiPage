import { invoke, isTauri } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { join } from "@tauri-apps/api/path";
import { writeImage, writeText } from "@tauri-apps/plugin-clipboard-manager";

export async function saveShare(pages: readonly Blob[]): Promise<boolean> {
  if (!pages.length) return false;
  if (!isTauri()) {
    pages.forEach((blob, index) => {
      const url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `恋页-游玩足迹-${index + 1}.png`; link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
    return true;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (pages.length === 1) {
    const path = await save({ title: "保存游玩足迹", defaultPath: `恋页-游玩足迹-${stamp}.png`, filters: [{ name: "PNG 图片", extensions: ["png"] }] });
    if (!path) return false;
    await invoke("share_image_save", { path: /\.png$/i.test(path) ? path : `${path}.png`, png: Array.from(new Uint8Array(await pages[0].arrayBuffer())) });
  } else {
    const directory = await open({ title: `选择保存 ${pages.length} 张分享图片的文件夹`, directory: true, multiple: false });
    if (typeof directory !== "string") return false;
    for (let index = 0; index < pages.length; index++) {
      const path = await join(directory, `恋页-游玩足迹-${stamp}-${index + 1}.png`);
      await invoke("share_image_save", { path, png: Array.from(new Uint8Array(await pages[index].arrayBuffer())) });
    }
  }
  return true;
}

export async function copyShareImage(blob: Blob): Promise<void> {
  if (isTauri()) await writeImage(await blob.arrayBuffer());
  else await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
}
export async function copyShareLinks(links: readonly string[]): Promise<void> {
  if (isTauri()) await writeText(links.join("\n"));
  else await navigator.clipboard.writeText(links.join("\n"));
}
export async function uploadShareImages(pages: readonly Blob[]): Promise<string> {
  if (!isTauri()) throw new Error("请在桌面应用中生成分享链接。");
  const images: number[][] = [];
  for (const page of pages) images.push(Array.from(new Uint8Array(await page.arrayBuffer())));
  return invoke<string>("share_images_upload", { pages: images });
}
