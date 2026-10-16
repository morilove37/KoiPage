import { useEffect, useRef, useState } from "react";
import { settingsGet } from "@/lib/db";
import { errorMessage, gameRunning, launchGame } from "@/features/io/io";
import { useAppStore } from "@/store/app";
import type { Game } from "@/types/game";

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
    pending.current = true;
    useAppStore.getState().setLaunching(game.id, true);
    setError(null); setNotice(null);
    try {
      if (!game.exePath?.trim()) throw new Error("尚未设置可执行文件，请在游戏详情的「路径与启动」中选择文件并保存。");
      const [useTool, running] = await Promise.all([settingsGet("locale_tool_use"), gameRunning(game.id)]);
      if (!mounted.current) return;
      // Match the launcher's accepted setting values. Running games retain
      // their control panel so the user can inspect or stop the process.
      if (running || ["1", "true", "yes", "on"].includes(useTool?.trim().toLowerCase() ?? "")) {
        setDialogGame(game);
        return;
      }
      await launchGame(game.id);
      if (mounted.current) { setNotice(`已启动「${game.title}」。`); onLaunched?.(); }
    } catch (cause) {
      if (mounted.current) setError(errorMessage(cause));
    } finally {
      pending.current = false;
      useAppStore.getState().setLaunching(game.id, false);
    }
  }

  return { launch, dialogGame, closeDialog: () => setDialogGame(null), error, notice };
}
