import { Link, useNavigate } from "react-router-dom";

import { useGameInstallation } from "@/features/installation/store";
import { Badge } from "@/components/ui/badge";
import { CoverImage } from "@/components/ui/cover-image";
import { CoverCensorButton } from "@/features/covers/CoverControls";
import { useGameCover } from "@/features/covers/store";
import { effectiveCoverCrop } from "@/features/covers/model";
import { cn } from "@/lib/utils";
import { formatRating } from "@/lib/rating";
import { openGameWithTransition } from "@/lib/game-opening";
import { GAME_STATUS_LABELS, isFavorite } from "@/types/game";
import type { Game, Tag } from "@/types/game";

export interface GameCardProps {
  game: Game;
  tags: Tag[];
  onToggleFavorite: (game: Game) => void;
  /** When true, a selection checkbox is shown and the link is disabled. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelected?: (gameId: number) => void;
}

/** Grid tile: cover, title, status/rating, tag chips, favourite toggle. */
export function GameCard({
  game,
  tags,
  onToggleFavorite,
  selectable = false,
  selected = false,
  onToggleSelected,
}: GameCardProps) {
  const favorite = isFavorite(game);
  const { archived } = useGameInstallation(game.id);
  const { preferences: coverPreferences } = useGameCover(game.id);
  const navigate = useNavigate();

  /**
   * In select mode the card must not navigate. `Link` would swallow the click
   * before the checkbox could be reached, so the whole tile becomes a button
   * that toggles selection instead.
   */
  const select = () => onToggleSelected?.(game.id);

  return (
    <div
      data-game-entry={game.id}
      className={cn(
        "lift group relative flex flex-col overflow-hidden rounded-lg border bg-card",
        selected
          ? "border-primary ring-2 ring-primary/60"
          : "border-border hover:border-primary/60",
      )}
    >
      {selectable ? (
        <button
          type="button"
          onClick={select}
          role="checkbox"
          aria-checked={selected}
          aria-label={`选择「${game.title}」`}
          className="absolute left-1.5 top-1.5 z-20 flex h-5 w-5 items-center justify-center rounded border border-white/70 bg-black/60 text-[11px] font-bold text-white shadow backdrop-blur"
        >
          {selected ? "✓" : ""}
        </button>
      ) : null}

      <Link
        to={selectable ? "#" : `/library/${game.id}`}
        onClick={(event) => {
          if (!selectable) {
            openGameWithTransition(event, game.id, () => navigate(`/library/${game.id}`));
            return;
          }
          // Intercept navigation entirely while selecting.
          event.preventDefault();
          select();
        }}
        className="flex flex-1 flex-col"
      >
        <div className="relative aspect-[3/4] w-full overflow-hidden bg-muted">
          <div data-game-cover className="absolute inset-0 overflow-hidden">
          <CoverImage
            gameId={game.id}
            path={game.coverPath}
            crop={effectiveCoverCrop(game.coverPath, coverPreferences)}
            alt={game.title}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
          />
          </div>

          <div className="absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
            {archived ? <Badge variant="secondary">已卸载 / 已归档</Badge> : null}
            <Badge variant="status" className="backdrop-blur">
              {GAME_STATUS_LABELS[game.status]}
            </Badge>
          </div>

          {game.rating !== null ? (
            <div className="absolute right-1.5 top-1.5 rounded-full bg-black/70 px-2 py-0.5 text-xs font-semibold text-white">
              {formatRating(game.rating)}
            </div>
          ) : null}
        </div>

        <div className="flex flex-1 flex-col gap-1.5 p-2.5">
          <p
            className="line-clamp-2 text-sm font-medium leading-snug"
            title={game.title}
          >
            {game.title}
          </p>
          {game.originalTitle ? (
            <p className="line-clamp-1 text-xs text-muted-foreground" title={game.originalTitle}>
              {game.originalTitle}
            </p>
          ) : null}
          <p className="mt-auto line-clamp-1 text-xs text-muted-foreground">
            {game.developer ?? "未知开发商"}
            {game.releaseDate ? ` · ${game.releaseDate}` : ""}
          </p>

          {tags.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {tags.slice(0, 3).map((tag) => (
                <Badge key={tag.id} color={tag.color} variant="outline">
                  {tag.name}
                </Badge>
              ))}
              {tags.length > 3 ? (
                <span className="text-xs text-muted-foreground">
                  +{tags.length - 3}
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </Link>

      {!selectable ? <CoverCensorButton gameId={game.id} title={game.title} className="absolute right-2 top-10 z-20 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100" /> : null}

      <button
        type="button"
        title={favorite ? "取消收藏" : "加入收藏"}
        aria-pressed={favorite}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleFavorite(game);
        }}
        className={cn(
          "absolute bottom-2.5 right-2.5 rounded-md px-1.5 py-0.5 text-sm transition-colors",
          favorite
            ? "text-amber-500 hover:bg-accent"
            : "text-muted-foreground opacity-0 hover:bg-accent hover:text-amber-500 group-hover:opacity-100",
        )}
      >
        {favorite ? "★" : "☆"}
      </button>
    </div>
  );
}

export default GameCard;
