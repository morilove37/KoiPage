/**
 * 实用工具页 — `/tools`.
 *
 * 启动增强与窗口缩放工具的集中配置：转区启动（内置 Locale Emulator）与
 * Magpie 窗口缩放。Magpie 功能介绍收在「窗口缩放」卡片右上角的小开关里，
 * 打开时才展开，避免长期占版面。卡片各自独立，其中一个出错不会影响其他卡片。
 */

import { useEffect, useId, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { scanRootsList, settingsGet, settingsSet } from "@/lib/db";
import { cn } from "@/lib/utils";
import { ArchiveImportPanel } from "@/features/scan/ArchiveImportPanel";
import { setPendingScanRoots } from "@/features/scan/pendingScan";
import { LocaleToolSection } from "./LocaleToolSection";
import { MagpieFeatureIntro } from "./MagpieFeatureIntro";
import { MagpieToolSection } from "./MagpieToolSection";
import { LunaToolSection } from "./LunaToolSection";
import { ToolsSectionNav } from "./ToolsSectionNav";

/** Settings key remembering whether the Magpie feature intro is expanded. */
const FEATURE_INTRO_KEY = "magpie_feature_intro_open";

function isEnabled(value: string | null): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

/** 与设置页的分区卡片保持同一套外观（含液态玻璃主题）。 */
function ToolCard({
  id,
  title,
  description,
  action,
  children,
}: {
  /** Anchor target for the section navigation. */
  id?: string;
  title: string;
  description: string;
  /** Optional control pinned to the right of the heading. */
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn(
        "rounded-lg border border-border bg-card p-5",
        "[.glass_&]:rounded-xl [.glass_&]:bg-[hsl(var(--glass))]",
        "[.glass_&]:backdrop-blur-glass [.glass_&]:backdrop-saturate-150",
        "[.glass_&]:shadow-[inset_0_1px_0_0_hsl(var(--glass-highlight)),0_12px_36px_-14px_var(--glass-shadow)]",
      )}
    >
      <header className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id={headingId} className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
      </header>
      {children}
    </section>
  );
}

/** Small labelled switch used to fold the feature introduction away. */
function FeatureIntroToggle({
  checked,
  disabled,
  onToggle,
}: {
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span id="magpie-intro-label" className="text-xs text-muted-foreground">功能介绍</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby="magpie-intro-label"
        disabled={disabled}
        onClick={onToggle}
        className={cn(
          "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-primary" : "bg-muted-foreground/40",
        )}
      >
        <span className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-1",
        )} />
      </button>
    </div>
  );
}

export default function ToolsPage() {
  const navigate = useNavigate();
  const [introOpen, setIntroOpen] = useState(false);
  const [introLoaded, setIntroLoaded] = useState(false);
  // First scan root is the default extraction folder; the panel lets a batch
  // override it.
  const [scanRoots, setScanRoots] = useState<string[]>([]);
  const [extractedRoots, setExtractedRoots] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    scanRootsList()
      .then((roots) => {
        if (alive) setScanRoots(roots.map((root) => root.path));
      })
      .catch(() => {
        // Without a scan root the panel asks the user to choose a folder.
      });
    return () => {
      alive = false;
    };
  }, []);

  function addExtractedRoots(roots: string[]) {
    setExtractedRoots((previous) => [...new Set([...previous, ...roots])]);
  }

  function scanExtracted() {
    if (extractedRoots.length === 0) return;
    setPendingScanRoots(extractedRoots);
    navigate("/library");
  }

  useEffect(() => {
    let alive = true;
    settingsGet(FEATURE_INTRO_KEY)
      .then((value) => {
        if (!alive) return;
        setIntroOpen(isEnabled(value));
      })
      .catch(() => {
        // A missing database only means the switch starts collapsed.
      })
      .finally(() => {
        if (alive) setIntroLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function toggleIntro() {
    const next = !introOpen;
    setIntroOpen(next); // optimistic, so the panel reacts in the same frame
    try {
      await settingsSet(FEATURE_INTRO_KEY, next ? "1" : "0");
    } catch {
      setIntroOpen(!next); // keep the UI honest when persisting fails
    }
  }

  return (
    <div data-tools-page className="mx-auto flex max-w-5xl items-start gap-6 p-6">
      {/* Section navigation sits immediately right of the app's main sidebar,
          exactly like the settings page, and stays pinned while scrolling. */}
      <aside className="sticky top-6 z-10 w-36 shrink-0 self-start">
        <ToolsSectionNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <header>
          <h1 className="text-xl font-semibold">实用工具</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            启动增强、窗口缩放、游戏翻译与压缩包解压工具的集中配置。
          </p>
        </header>

        <ToolCard
          id="tools-archive"
          title="游戏解压"
          description="把 .zip / .rar / .7z 或分卷压缩包直接拖进来，自动解压到扫描目录（可更换）。加密压缩包会提示输入密码；解压成功后原压缩包会移入回收站（可恢复），并可直接扫描其中的启动文件。"
        >
          <ArchiveImportPanel
            defaultDestination={scanRoots[0] ?? ""}
            onBusyChange={() => {}}
            onExtracted={addExtractedRoots}
          />
          {extractedRoots.length > 0 ? (
            <div className="mt-4 border-t border-border pt-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                已解压 {extractedRoots.length} 个文件夹：
                {extractedRoots.map((root) => root.split(/[\\/]/).pop() ?? root).join("、")}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                原压缩包已移入回收站，需要恢复原文件时请到回收站还原。
              </p>
              <Button className="mt-2" onClick={scanExtracted}>
                扫描解压出的启动文件并导入
              </Button>
            </div>
          ) : null}
        </ToolCard>

        <ToolCard
          id="tools-locale"
          title="转区启动"
          description="日文游戏在中文 Windows 上可能需要日语区域环境才能正常启动。内置 Locale Emulator 可离线使用，无需另装。"
        >
          <LocaleToolSection />
        </ToolCard>

        <ToolCard
          id="tools-luna"
          title="游戏翻译"
          description="内置 LunaTranslator，为原文游戏提供文本提取与翻译工具，可直接启动使用。"
        >
          <LunaToolSection />
        </ToolCard>

        <ToolCard
          id="tools-magpie"
          title="窗口缩放"
          description="Magpie 使用 GPU 缩放与滤镜，把低分辨率的游戏窗口放大到全屏。这里可以管理内置或外部 Magpie，并让它随游戏一起启动。"
          action={<FeatureIntroToggle checked={introOpen} disabled={!introLoaded} onToggle={() => void toggleIntro()} />}
        >
          <MagpieToolSection />
          {introOpen ? (
            <div className="mt-4 border-t border-border pt-4">
              <MagpieFeatureIntro />
            </div>
          ) : null}
        </ToolCard>
      </div>
    </div>
  );
}
