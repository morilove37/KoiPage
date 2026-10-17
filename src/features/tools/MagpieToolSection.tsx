import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { settingsGet, settingsSet } from "@/lib/db";
import { cn } from "@/lib/utils";
import { errorMessage } from "@/features/io/io";
import { magpieLaunch, magpieQuit, magpieScalingConfig, magpieScalingReset, magpieScalingSet, magpieStatus } from "./io";
import type { MagpieScalingConfig, MagpieSource, MagpieStatus } from "./io";

const DOWNLOAD_URL = "https://github.com/Blinue/Magpie/releases/latest";

/** `magpie_source` 设置值：内置 Magpie 或用户指定的外部程序。 */
type MagpieMode = "bundled" | "custom";

const SOURCE_LABELS: Record<MagpieSource, string> = {
  bundled: "内置 Magpie",
  custom: "自定义路径",
  auto: "自动检测",
  process: "正在运行的进程",
  none: "未找到",
};

export function MagpieToolSection() {
  const [status, setStatus] = useState<MagpieStatus | null>(null);
  const [mode, setMode] = useState<MagpieMode>("bundled");
  const [autostart, setAutostart] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scaling, setScaling] = useState<MagpieScalingConfig | null>(null);
  const [scalingLoading, setScalingLoading] = useState(true);
  const [scalingError, setScalingError] = useState<string | null>(null);
  const [selectedMode, setSelectedMode] = useState("");
  const [scalingBusy, setScalingBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // 立刻发起状态查询，和设置读取并行；先挂上失败处理，避免未处理的 rejection。
    const statusPromise = magpieStatus().then(
      next => ({ next, error: null as unknown }),
      cause => ({ next: null as MagpieStatus | null, error: cause }),
    );
    void (async () => {
      let savedPath: string | null = null;
      try {
        const [storedPath, autostartValue, sourceValue] = await Promise.all([
          settingsGet("magpie_path"),
          settingsGet("magpie_autostart"),
          settingsGet("magpie_source"),
        ]);
        savedPath = storedPath && storedPath.length > 0 ? storedPath : null;
        if (!cancelled) {
          setAutostart(["1", "true", "yes", "on"].includes(autostartValue?.trim().toLowerCase() ?? ""));
          // 未设置或非法值都按内置处理。
          setMode(sourceValue === "custom" ? "custom" : "bundled");
        }
      } catch (cause) {
        if (!cancelled) setError(errorMessage(cause));
      }

      const result = await statusPromise;
      if (cancelled) return;
      if (result.next) {
        const next = result.next;
        setStatus(next);
        // 便携版 Magpie 已在运行时，后端能从进程拿到路径。用户没有保存过路径时
        // 把它写回设置，下次冷启动也能直接使用；用户自己的选择永远不覆盖。
        if (!savedPath && next.source === "process" && next.path) {
          try {
            await settingsSet("magpie_path", next.path);
          } catch {
            // 可选优化：本次会话已经能通过 status.path 使用该路径。
          }
        }
      } else {
        setError(errorMessage(result.error));
      }
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
  }, []);

  // 缩放模式来自本机 Magpie 的 config.json，和上面的「程序/运行状态」互相独立，
  // 因此单独加载：读取失败只影响这一个区块。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [config, stored] = await Promise.all([magpieScalingConfig(), settingsGet("magpie_scaling_mode")]);
        if (cancelled) return;
        setScaling(config);
        const fallback = config.defaultIndex != null ? config.modes[config.defaultIndex]?.name ?? "" : "";
        const storedName = stored && config.modes.some(mode => mode.name === stored) ? stored : fallback;
        setSelectedMode(storedName);
      } catch (cause) {
        if (!cancelled) setScalingError(errorMessage(cause));
      } finally {
        if (!cancelled) setScalingLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  /**
   * 重新查询状态；顺手记住「从运行中的进程检测到的路径」。
   *
   * 只有 `source === "process"` 才写入：若用户已保存可用路径，后端会优先返回
   * `custom`，因此这里不会覆盖用户选择。写失败静默——本次会话已经能用
   * `status.path` 操作该 Magpie。
   */
  async function refreshStatus(): Promise<MagpieStatus> {
    const next = await magpieStatus();
    setStatus(next);
    if (next.source === "process" && next.path) {
      try {
        await settingsSet("magpie_path", next.path);
      } catch {
        // optional persistence
      }
    }
    return next;
  }

  async function chooseSource(value: MagpieMode) {
    if (loading || busy || value === mode) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await settingsSet("magpie_source", value);
      setMode(value);
      await refreshStatus();
      setNotice(value === "bundled" ? "已切换为内置 Magpie。" : "已切换为其他 Magpie 程序。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function checkBundled() {
    if (loading || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      await refreshStatus();
      setNotice("已重新检查内置 Magpie。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function chooseProgram() {
    if (loading || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const picked = await open({
        multiple: false,
        directory: false,
        title: "选择 Magpie 程序",
        filters: [{ name: "可执行文件", extensions: ["exe"] }],
      });
      if (typeof picked !== "string") return;
      await settingsSet("magpie_path", picked);
      await refreshStatus();
      setNotice("已保存 Magpie 程序路径。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function detectProgram() {
    if (loading || busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      // 清空自定义路径，让后端重新做自动检测。
      await settingsSet("magpie_path", null);
      await refreshStatus();
      setNotice("已改为自动检测 Magpie。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function toggleAutostart() {
    if (loading || busy || !programPath) return;
    const next = !autostart;
    setBusy(true); setError(null); setNotice(null);
    try {
      await settingsSet("magpie_autostart", next ? "1" : "0");
      setAutostart(next);
      setNotice(next ? "已开启随游戏启动。" : "已关闭随游戏启动。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function launchMagpie() {
    if (loading || busy || !programPath) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const started = await magpieLaunch();
      // Magpie 启动到托盘需要一点时间（开启管理员权限时还要等 UAC 确认），
      // 立刻查询会误报「未运行」；短暂轮询几次让状态行尽快反映真实结果。
      let next = await refreshStatus();
      for (let attempt = 0; started && !next.running && attempt < 4; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 400));
        next = await refreshStatus();
      }
      setNotice(started
        ? next.running ? "已启动 Magpie。" : "已请求启动 Magpie，请稍候它出现在托盘。"
        : "Magpie 已在运行。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function quitMagpie() {
    if (loading || busy || !running) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      const stopped = await magpieQuit();
      await refreshStatus();
      setNotice(stopped ? "已退出 Magpie。" : "没有找到正在运行的 Magpie 进程。");
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  async function changeScalingMode(value: string) {
    setScalingBusy(true); setScalingError(null); setError(null); setNotice(null);
    try {
      const result = await magpieScalingSet(value);
      setSelectedMode(value);
      setNotice(result.applied ? "已写入本机 Magpie 配置，下次启动 Magpie 生效。"
        : result.reason === "running" ? "已保存；Magpie 正在运行，将在下次启动时应用。"
        : result.reason === "no-config" ? "已保存；本机还没有 Magpie 配置，启动一次 Magpie 后会自动应用。"
        : "已保存默认缩放模式。");
      try { setScaling(await magpieScalingConfig()); } catch { /* 刷新失败不影响本次保存 */ }
    } catch (cause) { setScalingError(errorMessage(cause)); }
    finally { setScalingBusy(false); }
  }

  /** 把本机 Magpie 配置恢复为随应用分发的默认配置。 */
  async function resetScalingDefaults() {
    setConfirmReset(false);
    setScalingBusy(true); setScalingError(null); setError(null); setNotice(null);
    try {
      const result = await magpieScalingReset();
      setNotice(result.backupPath
        ? "已恢复应用内置的默认配置，原配置已备份为 config.koipage-before-reset.json；下次启动 Magpie 生效。"
        : "已写入应用内置的默认配置；下次启动 Magpie 生效。");
      const config = await magpieScalingConfig();
      setScaling(config);
      const fallback = config.defaultIndex != null ? config.modes[config.defaultIndex]?.name ?? "" : "";
      setSelectedMode(fallback);
    } catch (cause) {
      setScalingError(errorMessage(cause));
    } finally {
      setScalingBusy(false);
    }
  }

  async function reveal(path: string | null) {
    if (!path) return;
    setError(null); setNotice(null);
    try { await revealItemInDir(path); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  async function openDownloadPage() {
    setError(null); setNotice(null);
    try { await openUrl(DOWNLOAD_URL); }
    catch (cause) { setError(errorMessage(cause)); }
  }

  const programPath = status?.path ?? null;
  const configPath = status?.configPath ?? null;
  const running = status?.running === true;
  const available = programPath !== null && programPath.length > 0;
  const sourceLabel = status ? SOURCE_LABELS[status.source] : "";
  const localScalingMode = scaling && scaling.defaultIndex != null
    ? scaling.modes[scaling.defaultIndex]?.name ?? null
    : null;
  const selectedEffects = scaling?.modes.find(item => item.name === selectedMode)?.effects ?? [];

  return <div data-magpie-settings className="space-y-4">
    <div className="max-w-sm space-y-1.5">
      <label htmlFor="magpie-source" className="text-xs font-medium text-muted-foreground">Magpie 程序</label>
      <Select<MagpieMode> id="magpie-source" aria-label="Magpie 程序" value={mode} disabled={loading || busy}
        options={[{ value: "bundled", label: "内置 Magpie（推荐）" }, { value: "custom", label: "其他 Magpie 程序" }]}
        onValueChange={value => void chooseSource(value)} />
    </div>

    {mode === "bundled" ? <div className="space-y-2 rounded-lg border border-border bg-primary/5 p-3">
      <p className="text-sm font-medium">内置 Magpie {status?.bundledVersion ?? "0.12.1"}</p>
      <p className="text-xs text-muted-foreground">{loading ? "正在准备内置 Magpie…" : status?.bundledAvailable ? "已就绪，无需选择路径，可离线使用。" : "内置 Magpie 暂不可用，请重新检查。"}</p>
      <p className="text-xs leading-relaxed text-muted-foreground">首次使用时释放到本机应用数据目录，缩放仍需按 Magpie 快捷键。第三方组件，遵循 GPL-3.0 许可。</p>
      {!loading && !status?.bundledAvailable ? <Button variant="outline" size="sm" loading={busy} onClick={() => void checkBundled()}>重新检查内置 Magpie</Button> : null}
    </div> : <>
      {loading ? <div className="rounded-lg border border-border bg-primary/5 p-3">
        <p className="text-sm text-muted-foreground">正在检测 Magpie…</p>
      </div> : status ? <div className="space-y-2 rounded-lg border border-border bg-primary/5 p-3">
        {available ? <>
          <p className="text-sm font-medium">已找到 Magpie{status.version ? ` ${status.version}` : ""}</p>
          <p className="break-all text-xs text-muted-foreground">{programPath}</p>
          <p className="text-xs text-muted-foreground">来源：{sourceLabel}</p>
        </> : <>
          <p className="text-sm font-medium">未找到 Magpie</p>
          <p className="text-xs leading-relaxed text-muted-foreground">可从 GitHub Releases 下载 Windows x64 版本，解压后选择其中的 Magpie.exe。</p>
          <Button variant="outline" size="sm" onClick={() => void openDownloadPage()}>打开下载页</Button>
        </>}
      </div> : null}

      <div className="flex items-center gap-2">
        <input readOnly aria-label="Magpie 程序路径" value={programPath ?? ""} placeholder="选择 Magpie.exe"
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-3 text-xs text-muted-foreground" />
        <Button variant="outline" disabled={loading || busy} onClick={() => void chooseProgram()}>选择程序</Button>
        <Button variant="outline" disabled={loading || busy} onClick={() => void detectProgram()}>自动检测</Button>
      </div>
    </>}

    <div className="flex items-center justify-between gap-4">
      <div>
        <h3 id="magpie-autostart-label" className="text-sm font-medium">随游戏启动</h3>
        <p className="mt-1 text-xs text-muted-foreground">启动游戏前若 Magpie 未运行，会自动启动它。</p>
      </div>
      <button type="button" role="switch" aria-labelledby="magpie-autostart-label" aria-checked={autostart}
        disabled={loading || busy || !available}
        onClick={() => void toggleAutostart()}
        className={cn("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50", autostart ? "bg-primary" : "bg-muted-foreground/40")}>
        <span className={cn("inline-block h-4 w-4 rounded-full bg-white transition-transform", autostart ? "translate-x-6" : "translate-x-1")} />
      </button>
    </div>

    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span aria-hidden="true" className={cn("size-2 rounded-full", running ? "bg-emerald-500" : "bg-muted-foreground/40")} />
        {running ? "Magpie 正在运行" : "Magpie 未运行"}
      </span>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={loading || busy || !available} onClick={() => void launchMagpie()}>启动 Magpie</Button>
        <Button variant="outline" size="sm" disabled={loading || busy || !running} onClick={() => void quitMagpie()}>退出 Magpie</Button>
      </div>
    </div>

    <div className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {status?.hotkey ? `缩放快捷键：${status.hotkey}（读取自 Magpie 配置，可在 Magpie 内修改）` : "缩放快捷键：默认 Win + Shift + A（以 Magpie 设置为准）"}
      </p>
      <p className="text-xs leading-relaxed text-muted-foreground">启动游戏后按快捷键即可放大当前窗口；Magpie 默认以管理员权限运行，首次可能弹出 UAC 确认。</p>
    </div>

    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium">缩放算法与滤镜</h3>
      <p className="text-xs leading-relaxed text-muted-foreground">选择 Magpie 默认使用的缩放模式；效果链读取自本机 Magpie 配置，之后也可以直接在 Magpie 内调整。</p>

      {!scalingLoading && scaling?.usingAppDefaults ? (
        <p className="text-xs leading-relaxed text-muted-foreground">本机还没有 Magpie 配置，当前显示应用内置的默认配置（开发者调校）；首次启动 Magpie 或选择模式时会写入本机配置。</p>
      ) : null}

      {scalingLoading ? <p className="text-xs text-muted-foreground">正在读取本机 Magpie 配置…</p>
        : !scaling || scaling.modes.length === 0 ? <p className="text-xs leading-relaxed text-muted-foreground">未找到可用的缩放模式，请先启动一次 Magpie 生成配置后再回来设置。</p>
        : <>
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 space-y-1.5 sm:max-w-sm">
              <label htmlFor="magpie-scaling-mode" className="text-xs font-medium text-muted-foreground">默认缩放模式</label>
              <Select id="magpie-scaling-mode" aria-label="默认缩放模式" value={selectedMode} disabled={scalingBusy}
                options={scaling.modes.map(item => ({ value: item.name, label: item.name }))}
                onValueChange={value => void changeScalingMode(value)} />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={scalingBusy || running}
              title={running ? "请先退出 Magpie，再恢复默认配置" : "把本机 Magpie 配置替换为应用内置默认配置（原配置会备份）"}
              onClick={() => setConfirmReset(true)}
            >
              恢复内置默认
            </Button>
          </div>
          {running ? <p className="text-xs text-muted-foreground">Magpie 正在运行，恢复默认配置前请先退出它。</p> : null}
          <p className="text-xs text-muted-foreground">
            {scaling.usingAppDefaults
              ? `应用内置默认：${localScalingMode ?? "未设置"}；选择后会写入本机 Magpie 配置。`
              : `本机当前：${localScalingMode ?? "未设置"}；选择会在下次启动 Magpie 时生效。`}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {selectedEffects.length > 0
              ? selectedEffects.map((effect, index) => (
                <span key={`${effect}-${index}`} className="rounded-full border border-border bg-background/60 px-2.5 py-0.5 text-xs text-muted-foreground">{effect}</span>
              ))
              : <span className="text-xs text-muted-foreground">该模式没有额外滤镜</span>}
          </div>
        </>}

      {scalingError ? <p role="alert" className="text-xs text-destructive">{scalingError}</p> : null}
    </div>

    {programPath || configPath ? <div className="flex flex-wrap items-center gap-2">
      {programPath ? <Button variant="outline" size="sm" onClick={() => void reveal(programPath)}>打开程序文件夹</Button> : null}
      {configPath ? <Button variant="outline" size="sm" onClick={() => void reveal(configPath)}>打开配置文件夹</Button> : null}
    </div> : null}

    {notice ? <p role="status" className="text-sm text-emerald-500">{notice}</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

    <ConfirmDialog
      open={confirmReset}
      title="恢复内置默认配置？"
      description="将把本机 Magpie 配置替换为应用内置的默认配置（开发者调校，含 1k 等模式），并清除恋页里保存的默认缩放模式。原配置会备份为 config.koipage-before-reset.json；此操作需要先退出 Magpie。"
      confirmText="恢复默认"
      destructive
      busy={scalingBusy}
      onConfirm={() => void resetScalingDefaults()}
      onCancel={() => setConfirmReset(false)}
    />
  </div>;
}
