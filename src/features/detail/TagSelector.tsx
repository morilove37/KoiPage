import { cn } from "@/lib/utils";
import type { Tag } from "@/types/game";

export interface TagSelectorProps {
  allTags: Tag[];
  selectedIds: number[];
  onChange: (tagIds: number[]) => void;
  emptyHint?: string;
  className?: string;
}

/**
 * Multi-select chip picker for a game's tags.
 *
 * Renders the full tag catalogue so a new game can be classified without a
 * second dialog; selection order follows the catalogue, not click order.
 */
export function TagSelector({
  allTags,
  selectedIds,
  onChange,
  emptyHint = "还没有标签，先到「标签管理」里创建。",
  className,
}: TagSelectorProps) {
  if (allTags.length === 0) {
    return <p className={cn("text-xs text-muted-foreground", className)}>{emptyHint}</p>;
  }

  const toggle = (tagId: number) => {
    onChange(
      selectedIds.includes(tagId)
        ? selectedIds.filter((id) => id !== tagId)
        : [...selectedIds, tagId],
    );
  };

  return (
    <div className={cn("flex flex-wrap gap-1.5", className)}>
      {allTags.map((tag) => {
        const active = selectedIds.includes(tag.id);
        return (
          <button
            key={tag.id}
            type="button"
            aria-pressed={active}
            onClick={() => toggle(tag.id)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors",
              active
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {tag.color ? (
              <span
                aria-hidden
                className="size-2 rounded-full"
                style={{ backgroundColor: tag.color }}
              />
            ) : null}
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}

export default TagSelector;
