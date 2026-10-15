import { gameCreate, gameUpdate, metadataCoverCache } from "@/lib/db";
import type { Game, GameInput, MetadataDetail, MetadataField } from "@/lib/db";
import { errorMessage, metadataInput } from "./fields";

/** Commit once. A failed cover cache must never turn a saved game into a retry. */
export async function createGameFromMetadata(
  draft: GameInput,
  detail: MetadataDetail,
  fields: readonly MetadataField[],
  useCover: boolean,
): Promise<{ game: Game; coverWarning: string | null }> {
  const game = await gameCreate(metadataInput(draft, detail, fields, useCover));
  let coverWarning: string | null = null;
  if (useCover && detail.coverUrl) {
    try {
      const localPath = await metadataCoverCache(game.id, detail.coverUrl, draft.installPath);
      await gameUpdate(game.id, { coverPath: localPath });
      game.coverPath = localPath;
    } catch (cause) {
      coverWarning = `封面缓存失败，已保留在线封面：${errorMessage(cause)}`;
      console.warn("[import]", coverWarning);
    }
  }
  return { game, coverWarning };
}
