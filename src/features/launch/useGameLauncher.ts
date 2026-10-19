import { useEffect, useRef, useState } from "react";
import { settingsGet } from "@/lib/db";
import { errorMessage } from "@/features/io/io";
import { useAppStore } from "@/store/app";
import type { Game } from "@/types/game";
import { gameProcesses } from "./game-process";

/** Both home and detail use the same click-to-launch behavior. */
export function useGameLauncher(onLaunched?: () => void) {
  const [dialogGame, setDialogGame] = useState<Game | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  async function launch(game: Game) {
    if (pending.current || useAppStore.getState().launching[game.id]) return;
    if (useAppStore.getState().gameProcesses[game.id]?.status === "running") {
      setError(null); setNotice(null);
      setDialogGame(game);
      return;
    }
    pending.current = true;
    setError(null); setNotice(null);
    try {
      const outcome = await gameProcesses.start(game.id, async () => {
        if (!game.exePath?.trim()) throw new Error("尚未设置可执行文件，请在游戏详情的「路径与启动」中选择文件并保存。");
        const useTool = await settingsGet("locale_tool_use");
        // Avoid launching from a page that was left during the preflight.
        if (!mounted.current) return false;
        return !["1", "true", "yes", "on"].includes(useTool?.trim().toLowerCase() ?? "");
      });
      if (!mounted.current) return;
      if (outcome.kind === "running" || outcome.kind === "panel") {
        setDialogGame(game);
        return;
      }
      if (outcome.kind === "started") { setNotice(`已启动「${game.title}」。`); onLaunched?.(); }
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      pending.current = false;
    }
  }

  return { launch, dialogGame, closeDialog: () => setDialogGame(null), error, notice };
}
