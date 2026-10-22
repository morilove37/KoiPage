import { Link, useNavigate } from "react-router-dom";

import { useGameInstallation } from "@/features/installation/store";
import { Badge } from "@/components/ui/badge";
import { CoverImage } from "@/components/ui/cover-image";
import { CoverCensorButton } from "@/features/covers/CoverControls";
import { cn } from "@/lib/utils";
import { formatRating } from "@/lib/rating";
import { openGameWithTransition } from "@/lib/game-opening";
import { GAME_STATUS_LABELS, formatPlayTime, isFavorite } from "@/types/game";
import type { Game, Tag } from "@/types/game";

export interface GameRowProps {
  game: Game;
  tags: Tag[];
  onToggleFavorite: (game: Game) => void;
  /** When true, a selection checkbox replaces the row's navigation. */
  selectable?: boolean;
  selected?: boolean;
  onToggleSelected?: (gameId: number) => void;
}

/** Formats an ISO8601 timestamp for the "last played" column. */
function formatLastPlayed(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** One row of the list-view table. Column widths mirror the header in LibraryPage. */
export function GameRow({
  game,
  tags,
  onToggleFavorite,
  selectable = false,
  selected = false,
  onToggleSelected,
}: GameRowProps) {
  const favorite = isFavorite(game);
  const { archived } = useGameInstallation(game.id);
  const navigate = useNavigate();
  const select = () => onToggleSelected?.(game.id);

  return (
    <div
      data-game-entry={game.id}
      className={cn(
        "flex items-center gap-3 border-b border-border px-3 py-2 text-sm transition-colors last:border-b-0",
        selected ? "bg-primary/10" : "hover:bg-accent/50",
      )}
    >
      {selectable ? (
        <button
          type="button"
          onClick={select}
          role="checkbox"
          aria-checked={selected}
          aria-label={`选择「${game.title}」`}
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] font-bold",
            selected
              ? "border-primary bg-primary text-primary-foreground"
              : "border-border bg-background",
          )}
        >
          {selected ? "✓" : ""}
        </button>
      ) : null}

      <div data-game-cover className="h-10 w-8 shrink-0 overflow-hidden rounded bg-muted">
        <CoverImage
          gameId={game.id}
          path={game.coverPath}
          alt=""
          fallbackText=""
          className="h-full w-full object-cover"
        />
      </div>

      <div className="min-w-0 flex-1">
        <Link
          to={selectable ? "#" : `/library/${game.id}`}
          onClick={(event) => {
            if (!selectable) {
              openGameWithTransition(event, game.id, () => navigate(`/library/${game.id}`));
              return;
            }
            // Selecting must never navigate away mid-selection.
            event.preventDefault();
            select();
          }}
          className="line-clamp-1 font-medium hover:text-primary hover:underline"
          title={game.title}
        >
          {game.title}
        </Link>
        {archived ? <Badge variant="secondary" className="mt-1">已卸载 / 已归档</Badge> : null}
        {tags.length > 0 ? (
          <div className="mt-0.5 flex flex-wrap gap-1">
            {tags.slice(0, 4).map((tag) => (
              <Badge key={tag.id} color={tag.color} variant="outline">
                {tag.name}
              </Badge>
            ))}
          </div>
        ) : game.originalTitle ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">
            {game.originalTitle}
          </p>
        ) : null}
      </div>

      <span className="hidden w-32 shrink-0 truncate text-xs text-muted-foreground md:block">
        {game.developer ?? "—"}
      </span>

      <span className="hidden w-24 shrink-0 md:block">
        <Badge variant="status">{GAME_STATUS_LABELS[game.status]}</Badge>
      </span>

      <span className="hidden w-14 shrink-0 text-right text-xs md:block">
        {formatRating(game.rating)}
      </span>

      <span className="hidden w-24 shrink-0 text-right text-xs text-muted-foreground md:block">
        {formatPlayTime(game.playTimeSeconds)}
      </span>

      <span className="hidden w-28 shrink-0 text-right text-xs text-muted-foreground md:block">
        {formatLastPlayed(game.lastPlayedAt)}
      </span>

      {!selectable ? <CoverCensorButton gameId={game.id} title={game.title} className="w-20 shrink-0 text-center" /> : null}

      <button
        type="button"
        title={favorite ? "取消收藏" : "加入收藏"}
        aria-pressed={favorite}
        onClick={() => onToggleFavorite(game)}
        className={cn(
          "w-8 shrink-0 rounded px-1 text-center text-sm transition-colors hover:bg-accent",
          favorite ? "text-amber-500" : "text-muted-foreground hover:text-amber-500",
        )}
      >
        {favorite ? "★" : "☆"}
      </button>
    </div>
  );
}

export default GameRow;
