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

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { errorMessage, gameRunning, launchGame, stopGame } from "@/features/io/io";
import type { GameExitedPayload } from "@/features/io/io";
import { useAppStore } from "@/store/app";
import { formatPlayTime } from "@/types/game";
import type { Game } from "@/types/game";

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
  const launching = useAppStore((state) => state.launching[game.id] === true);
  const setLaunching = useAppStore((state) => state.setLaunching);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [pid, setPid] = useState<number | null>(null);

  const exePath = game.exePath?.trim() ?? "";
  const canLaunch = exePath !== "";

  // Re-read the process registry per open. A dialog-local boolean becomes stale
  // as soon as the panel is closed while the game keeps running.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setPid(null);
    setBusy(false);
    let cancelled = false;
    void gameRunning(game.id)
      .then((value) => {
        if (!cancelled) setRunning(value);
      })
      .catch((cause) => {
        if (!cancelled) setError(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [open, game.id]);

  useEffect(() => {
    if (!open) return;
    let unlisten: UnlistenFn | null = null;
    let cancelled = false;
    void listen<GameExitedPayload>("game-exited", (event) => {
      if (event.payload.gameId !== game.id) return;
      setRunning(false);
      setPid(null);
      onLaunched?.();
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    }).catch((cause) => {
      if (!cancelled) setError(errorMessage(cause));
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [open, game.id, onLaunched]);

  async function start() {
    if (!canLaunch) return;
    setBusy(true);
    setError(null);
    setLaunching(game.id, true);
    try {
      const result = await launchGame(game.id);
      setRunning(true);
      setPid(result.pid ?? null);
      onLaunched?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
      setLaunching(game.id, false);
    }
  }

  async function stop() {
    setBusy(true);
    setError(null);
    try {
      const stopped = await stopGame(game.id);
      if (!stopped) {
        // Not an error: the process may already have exited on its own.
        setError("没有找到正在运行的进程（可能已经退出）。");
      }
      setRunning(false);
      setPid(null);
      onLaunched?.();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
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
            {running ? "运行中" : "启动游戏"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
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
