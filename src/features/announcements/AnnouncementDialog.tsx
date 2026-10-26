import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { BRAND } from "@/lib/brand";
import { useUpdateStore } from "@/lib/updater";
import { closeAnnouncement, initializeAnnouncements, useAnnouncementStore } from "./store";
import type { AnnouncementKind } from "./model";
import { AnnouncementContact } from "./AnnouncementContact";
import { AnnouncementCommunity } from './AnnouncementCommunity';

// Release notes travel with the installed version and remain available offline.
const releases = import.meta.glob<string>("/docs/releases/v*.md", { query: "?raw", import: "default", eager: true });
const releaseNotes = releases[`/docs/releases/v${BRAND.version}.md`];
const plainText = (value: string) => value.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1");

function VersionContent() {
  if (!releaseNotes) return <p className="text-sm leading-relaxed text-muted-foreground">当前版本为 v{BRAND.version}，此版本暂未附带详细更新公告。可在设置的「关于」中前往 GitHub 查看更新记录。</p>;
  const blocks = releaseNotes.trim().split(/\r?\n\s*\r?\n/);
  return <div className="space-y-4 text-sm leading-relaxed">
    {blocks.map((block, index) => {
      if (index === 0 && /^#{1,2}\s/.test(block)) return null;
      if (/^#{1,6}\s/.test(block)) return <h3 key={index} className="font-semibold">{plainText(block.replace(/^#{1,6}\s+/, ""))}</h3>;
      if (/^- /.test(block)) return <ul key={index} className="list-disc space-y-1.5 pl-5 text-muted-foreground">{block.split(/\r?\n/).map((line, item) => <li key={item}>{plainText(line.replace(/^- /, ""))}</li>)}</ul>;
      return <p key={index} className="whitespace-pre-line text-muted-foreground">{plainText(block)}</p>;
    })}
  </div>;
}

function WelcomeContent() {
  return <div className="space-y-4 text-sm leading-relaxed">
    <p>欢迎来到恋页。这里用来收藏你的 Galgame、记录游玩足迹，也帮你决定下一次与哪部作品相遇。</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <section className="rounded-lg border border-border bg-muted/40 p-3">
        <h3 className="font-semibold">先把游戏放进书架</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">在「游戏库 → 添加游戏」选择 exe 或扫描目录，再匹配作品资料。支持一键导入和手动填写；压缩包可先到「实用工具 → 游戏解压」处理。</p>
      </section>
      <section className="rounded-lg border border-border bg-muted/40 p-3">
        <h3 className="font-semibold">按自己的习惯整理</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">「游戏文件夹」提供社团和游玩状态分类，也能自建多级文件夹。每个文件夹可选择收纳子文件夹或游戏；在「管理游戏」中统一加入、移出。</p>
      </section>
    </div>
    <h3 className="font-semibold">这些入口也可以看看</h3>
    <ul className="list-disc space-y-2 pl-5 text-muted-foreground">
      <li>首页可继续上次的故事、随机选游戏；点击「游玩中」「已通关」「待开始」可直接查看对应分类。</li>
      <li>详情页可调整封面、启动设置和存档备份；「游玩历史」支持补记与修正，补记正时长后自动设为游玩中。</li>
      <li>角色生日展示今天及未来 30 天的寿星；主题、背景和标签汉化在设置中调整，转区、Luna 翻译及窗口缩放在实用工具中配置。</li>
      <li>分享足迹可隐藏作品、替换封面；只有主动生成分享链接时才上传分享图，链接约 24 小时后过期。</li>
    </ul>
    <p className="text-xs text-muted-foreground">游戏库与记录保存在本机，建议在设置的「数据管理」中定期备份。本公告和当前版本公告都可以在「设置 → 公告」重新查看。</p>
  </div>;
}

function Announcement({ kind, blocked }: { kind: AnnouncementKind; blocked: boolean }) {
  const state = useAnnouncementStore();
  const [dismissed, setDismissed] = useState(kind === "welcome"
    ? state.preferences?.welcomeDismissed === true
    : state.preferences?.dismissedUpdateVersion === BRAND.version);
  const close = () => { if (!state.saving && !blocked) void closeAnnouncement(dismissed); };
  return <Dialog
    open={!blocked}
    onClose={close}
    title={<span className="flex items-center gap-2 text-lg"><img src={BRAND.icon} alt="" width={28} height={28} />{kind === "welcome" ? "恋页 · 应用公告" : `版本公告 · v${BRAND.version}`}</span>}
    description={kind === "welcome" ? BRAND.tagline : "当前版本更新内容 · 可在设置中随时重新查看"}
    className="max-w-2xl"
    footer={<div className="flex w-full flex-wrap items-center justify-between gap-3">
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={dismissed} disabled={state.saving} onChange={event => setDismissed(event.target.checked)} className="h-4 w-4 accent-primary" />
        {kind === "welcome" ? "今后不再展示" : "下次更新前不再展示"}
      </label>
      <Button loading={state.saving} onClick={close}>我知道了</Button>
    </div>}
  >
    <div data-announcement={kind} className="space-y-4">
      <AnnouncementCommunity />
      {kind === "welcome" ? <WelcomeContent /> : <VersionContent />}
      <AnnouncementContact />
      {state.error ? <p role="alert" className="text-sm text-destructive">{state.error}</p> : null}
    </div>
  </Dialog>;
}

export function AnnouncementDialog() {
  const kind = useAnnouncementStore(state => state.manual ?? state.queue[0]);
  const revision = useAnnouncementStore(state => state.revision);
  const updateOpen = useUpdateStore(state => state.dialogOpen);
  useEffect(() => { void initializeAnnouncements(); }, []);
  return kind ? <Announcement key={`${kind}-${revision}`} kind={kind} blocked={updateOpen} /> : null;
}
