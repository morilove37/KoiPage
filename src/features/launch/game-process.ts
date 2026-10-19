import { gameRunning, launchGame, stopGame } from "@/features/io/io";
import { useAppStore } from "@/store/app";
import { createGameProcessController } from "./process-state";

/** One coordinator per frontend session. The backend registry only contains
 * processes launched by this app; this does not scan unrelated OS processes. */
export const gameProcesses = createGameProcessController({
  readRunning: gameRunning,
  launch: launchGame,
  stop: stopGame,
  onChange: (id, state) => useAppStore.getState().setGameProcess(id, state),
});
