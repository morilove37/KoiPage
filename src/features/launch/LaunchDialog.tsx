/**
 * 「启动窗口」 — the launch panel for one game.
 *
 * The backend launcher (`launch_game` / `stop_game`) has existed since early on,
 * but until now nothing in the UI called it: the detail page only had a 启动参数
 * text field. This dialog is that missing entry point.
 *
 * It is deliberately **read-only about configuration**. The exe path, working
 * directory and arguments are edited in the detail page's 路径与启动 tab; letting
 * both places write them would mean two sources of truth for the same fields and
 * a save in one silently discarding the other.
 *
 * Launching is handled by `launchGame`, which starts the process, opens a play
 * session and stamps `last_played_at`. The process-exit watcher on the Rust side
 * closes the session, adds to `play_time_seconds` and emits `game-exited`, which
 * is what the caller uses to refresh the displayed totals.
 */

import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { errorMessage } from "@/features/io/io";
import { formatPlayTime } from "@/types/game";
import type { Game } from "@/types/game";
import { gameProcesses } from "./game-process";
import { useGameProcess } from "./useGameProcess";
import { launchProfileGet } from './profile-api';
import type { EffectiveLaunchProfile } from './profile-api';
import { magpieQuit, magpieStatus } from '@/features/tools/io';

export interface LaunchDialogProps {
  open: boolean;
  game: Game;
  onClose: () => void;
  /** Fired after a successful launch or a stop, so the caller can refresh. */
  onLaunched?: () => void;
}

/** One read-only `label: value` row; `empty` renders in the muted style. */
function Row({ label, value }: { label: string; value: string | null }) {
  const missing = !value || value.trim() === "";
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className={
          missing
            ? "break-all text-xs italic text-muted-foreground"
            : "break-all font-mono text-xs"
        }
      >
        {missing ? "未设置" : value}
      </dd>
    </div>
  );
}

export default function LaunchDialog({
  open,
  game,
  onClose,
  onLaunched,
}: LaunchDialogProps) {
  const process = useGameProcess(game.id, open);
  const launching = process.status === "starting";
  const running = process.status === "running";
  const pid = process.pid;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [effective, setEffective] = useState<EffectiveLaunchProfile | null>(null);
  const [restartMagpie, setRestartMagpie] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const exePath = game.exePath?.trim() ?? "";
  const canLaunch = exePath !== "";

  useEffect(() => {
    if (!open) return;
    setError(null);
    let alive = true;
    setRestartMagpie(false);
    void launchProfileGet(game.id).then(async value => {
      const restart = value.magpie && Boolean(value.profile.scalingMode) && (await magpieStatus()).running;
      if (alive) { setEffective(value); setRestartMagpie(restart); }
    }).catch(cause => { if (alive) setError(errorMessage(cause)); });
    return () => { alive = false; };
  }, [open, game.id]);

  async function start() {
    if (!canLaunch || running || launching || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      if (restartMagpie) {
        await magpieQuit();
        if ((await magpieStatus()).running) throw new Error('Magpie 尚未退出，请在其实用工具页面或托盘中退出后重试。');
        if (mounted.current) setRestartMagpie(false);
      }
      const outcome = await gameProcesses.start(game.id);
      if (mounted.current && outcome.kind === "started") onLaunched?.();
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function stop() {
    if (pending.current || launching) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const stopped = await gameProcesses.stop(game.id);
      if (!mounted.current) return;
      if (!stopped) {
        // Not an error: the process may already have exited on its own.
        setError("没有找到正在运行的进程（可能已经退出）。");
      }
      onLaunched?.();
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="启动游戏"
      description={game.title}
      footer={
        <>
          {running ? (
            <Button variant="outline" loading={busy} onClick={() => void stop()}>
              停止游戏
            </Button>
          ) : null}
          <Button variant="outline" onClick={onClose} disabled={busy}>
            关闭
          </Button>
          <Button
            loading={busy || launching}
            disabled={!canLaunch || running}
            onClick={() => void start()}
            title={canLaunch ? undefined : "未设置 exe 路径"}
          >
            {launching ? "启动中…" : running ? "运行中" : restartMagpie ? '退出 Magpie 并启动游戏' : "启动游戏"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {restartMagpie ? <p className="rounded-md border border-primary/40 bg-primary/10 p-3 text-xs leading-relaxed">Magpie 已在运行，应用本款缩放模式需要重新启动它。确认启动会先退出当前 Magpie，再按本款配置启动；其他游戏正在使用的缩放也会结束。</p> : null}
        {!canLaunch ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs">
            还没有设置 exe 路径，无法启动。请先到上方的「路径与启动」标签里填写并保存。
          </div>
        ) : null}

        {error ? (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        {running ? (
          <div className="flex items-center gap-2 rounded-md border border-primary/40 bg-primary/10 px-3 py-2 text-xs">
            <span className="inline-block h-2 w-2 rounded-full bg-primary" />
            <span className="font-medium">运行中</span>
            {pid !== null ? (
              <span className="text-muted-foreground">PID {pid}</span>
            ) : null}
          </div>
        ) : null}

        <dl className="flex flex-col gap-3">
          {effective ? <Row label="本次启动配置" value={`转区${effective.locale ? '开启' : '关闭'} · Magpie ${effective.magpie ? '开启' : '关闭'} · Luna ${effective.luna ? '开启' : '关闭'}`} /> : null}
          <Row label="可执行文件" value={game.exePath} />
          <Row label="工作目录" value={game.workdir} />
          <Row label="启动参数" value={game.launchArgs} />
          <Row label="存档路径" value={game.savePath} />
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">已记录游玩时长</dt>
            <dd className="text-xs">{formatPlayTime(game.playTimeSeconds)}</dd>
          </div>
        </dl>

        <p className="text-xs text-muted-foreground">
          工作目录留空时会使用 exe 所在目录。如需转区或调整启动参数，请到「路径与启动」标签或设置页修改后保存。
        </p>
      </div>
    </Dialog>
  );
}
