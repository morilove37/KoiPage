import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useSearchParams } from "react-router-dom";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/card";
import { Field, Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { useLocalizedTags } from "@/lib/localization";
import {
  gameUpdate,
  gamesList,
  gamesTagsGet,
  tagCreate,
  tagDelete,
  tagUpdate,
  tagsList,
} from "@/lib/db";
import { useAppStore } from "@/store/app";
import { isFavorite } from "@/types/game";
import type { Game, Tag } from "@/types/game";

import { GameCard } from "@/features/library/GameCard";
import { GameRow } from "@/features/library/GameRow";

/**
 * Join tag names for a one-line notice, capping the list so a cleanup of 80
 * orphans does not push the whole page down.
 */
function summariseNames(names: readonly string[], limit = 6): string {
  const shown = names.slice(0, limit).join("、");
  return names.length > limit ? `${shown} 等 ${names.length} 个` : shown;
}

export default function TagsPage() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const targetValue = searchParams.get("tagId");
  const targetTagId = targetValue !== null && /^[1-9]\d*$/.test(targetValue) && Number.isSafeInteger(Number(targetValue))
    ? Number(targetValue)
    : null;
  const [tags, setTags] = useState<Tag[]>([]);
  const [links, setLinks] = useState<Array<[number, number]>>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);

  const [pendingDelete, setPendingDelete] = useState<Tag | null>(null);
  const [deleting, setDeleting] = useState(false);

  /** Tag ids whose "games using this tag" panel is open. */
  const [expandedTagIds, setExpandedTagIds] = useState<Set<number>>(() => new Set());
  const { t } = useLocalizedTags();

  /**
   * Expanded panels render the games with the library's own card / row
   * components, in whichever of the two views the user last picked there.
   */
  const viewMode = useAppStore((state) => state.library.viewMode);

  /** One round trip per table; used by both the bootstrap and every reload. */
  const fetchAll = useCallback(async () => {
    const [tagList, linkList, gameList] = await Promise.all([
      tagsList(),
      gamesTagsGet(),
      gamesList(),
    ]);
    return { tagList, linkList, gameList };
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { tagList, linkList, gameList } = await fetchAll();
      setTags(tagList);
      setLinks(linkList);
      setGames(gameList);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [fetchAll]);

  // Keep navigation tied to the tag id: translated names can coincide or change.
  // Wait for the async list, then reveal, focus and scroll to its exact row once
  // per navigation. Later edits / translations must not steal the user's scroll.
  const locatedNavigation = useRef<string | null>(null);
  useEffect(() => {
    if (loading || targetTagId === null || !tags.some(tag => tag.id === targetTagId)) return;
    const navigation = `${location.key}:${targetTagId}`;
    if (locatedNavigation.current === navigation) return;
    setExpandedTagIds(current => current.has(targetTagId) ? current : new Set([...current, targetTagId]));
    setEditingId(null);
    const frame = requestAnimationFrame(() => {
      const row = document.getElementById(`tag-${targetTagId}`);
      if (!row) return;
      row.focus({ preventScroll: true });
      row.scrollIntoView({ block: "start", behavior: "instant" });
      locatedNavigation.current = navigation;
    });
    return () => cancelAnimationFrame(frame);
  }, [loading, tags, targetTagId, location.key]);

  /**
   * First load, plus the automatic cleanup of orphan tags.
   *
   * A tag no game carries is dead weight: nothing can select it in the library
   * and it only clutters the picker, so entering this page deletes those rows
   * and says so. The deletion happens *before* the first render of the list, so
   * a tag is never shown and then yanked away — and the `bootstrapped` ref keeps
   * it to once per mount even under React's double-invoked StrictMode effects
   * (a second pass would find nothing left to delete, but would also re-issue
   * the queries and trample a notice the user is reading).
   *
   * Only tags are deleted; the games themselves are never touched.
   */
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const first = await fetchAll();
        const used = new Set(first.linkList.map(([, tagId]) => tagId));
        const orphans = first.tagList.filter((tag) => !used.has(tag.id));

        const cleaned: string[] = [];
        const failed: string[] = [];
        if (orphans.length > 0) {
          const results = await Promise.allSettled(
            orphans.map((tag) => tagDelete(tag.id)),
          );
          results.forEach((result, index) => {
            if (result.status === "fulfilled") cleaned.push(orphans[index].name);
            else failed.push(orphans[index].name);
          });
        }

        // Re-read only when something was actually removed, so the list we
        // render always matches the database.
        const next =
          cleaned.length > 0
            ? await fetchAll()
            : { tagList: first.tagList, linkList: first.linkList, gameList: first.gameList };

        setTags(next.tagList);
        setLinks(next.linkList);
        setGames(next.gameList);

        if (cleaned.length > 0) {
          setNotice(`已自动清理 ${cleaned.length} 个未使用标签：${summariseNames(cleaned)}`);
        }
        if (failed.length > 0) {
          setError(`有 ${failed.length} 个未使用标签清理失败：${summariseNames(failed)}`);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setLoading(false);
      }
    })();
  }, [fetchAll]);

  /** tagId -> number of games carrying it. */
  const usageCount = useMemo(() => {
    const counts = new Map<number, number>();
    for (const [, tagId] of links) {
      counts.set(tagId, (counts.get(tagId) ?? 0) + 1);
    }
    return counts;
  }, [links]);

  /** tagId -> the games carrying it, alphabetical, for the expanded panel. */
  const gamesByTag = useMemo(() => {
    const byId = new Map(games.map((game) => [game.id, game]));
    const map = new Map<number, Game[]>();
    for (const [gameId, tagId] of links) {
      const game = byId.get(gameId);
      if (!game) continue;
      const list = map.get(tagId);
      if (list) list.push(game);
      else map.set(tagId, [game]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.title.localeCompare(b.title, "zh-Hans-CN") || a.id - b.id);
    }
    return map;
  }, [games, links]);

  /** gameId -> tag ids, and the lookup the library card/row components expect. */
  const tagsByGame = useMemo(() => {
    const map = new Map<number, number[]>();
    for (const [gameId, tagId] of links) {
      const list = map.get(gameId);
      if (list) list.push(tagId);
      else map.set(gameId, [tagId]);
    }
    return map;
  }, [links]);

  const tagById = useMemo(() => {
    const map = new Map<number, Tag>();
    for (const tag of tags) map.set(tag.id, { ...tag, name: t(tag.name) });
    return map;
  }, [tags, t]);

  /** The tag chips a game card/row shows, in the user's language. */
  const gameTags = useCallback(
    (gameId: number) =>
      (tagsByGame.get(gameId) ?? [])
        .map((tagId) => tagById.get(tagId))
        .filter((tag): tag is Tag => tag !== undefined),
    [tagsByGame, tagById],
  );

  const toggleExpanded = useCallback((tagId: number) => {
    setExpandedTagIds((current) => {
      const next = new Set(current);
      if (next.has(tagId)) next.delete(tagId);
      else next.add(tagId);
      return next;
    });
  }, []);

  const create = async () => {
    const name = newName.trim();
    if (name === "") {
      setError("标签名不能为空。");
      return;
    }
    if (tags.some((tag) => tag.name === name)) {
      setError(`标签「${name}」已存在。`);
      return;
    }
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      // Colours are no longer part of the tag feature; new tags stay plain.
      await tagCreate(name, null);
      setNewName("");
      setNotice(
        `已创建标签「${name}」。它还没有被任何游戏使用，下次进入本页时会被自动清理。`,
      );
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCreating(false);
    }
  };

  const startEdit = (tag: Tag) => {
    setEditingId(tag.id);
    setEditName(tag.name);
    setError(null);
    setNotice(null);
  };

  const saveEdit = async () => {
    if (editingId === null) return;
    const name = editName.trim();
    if (name === "") {
      setError("标签名不能为空。");
      return;
    }
    if (tags.some((tag) => tag.id !== editingId && tag.name === name)) {
      setError(`标签「${name}」已存在。`);
      return;
    }
    setSavingEdit(true);
    setError(null);
    try {
      // Rename only: the colour column is left untouched (it is unmanaged now).
      await tagUpdate(editingId, name);
      setEditingId(null);
      setNotice("标签已更新。");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSavingEdit(false);
    }
  };

  const remove = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await tagDelete(pendingDelete.id);
      setNotice(`已删除标签「${pendingDelete.name}」。`);
      setPendingDelete(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  };

  const toggleFavorite = async (game: Game) => {
    const next = isFavorite(game) ? 0 : 1;
    // Optimistic, exactly like the library: the star must react instantly.
    setGames((current) =>
      current.map((item) => (item.id === game.id ? { ...item, favorite: next } : item)),
    );
    try {
      await gameUpdate(game.id, { favorite: next });
    } catch (cause) {
      setGames((current) =>
        current.map((item) =>
          item.id === game.id ? { ...item, favorite: game.favorite } : item,
        ),
      );
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="flex flex-col gap-4 p-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">标签管理</h1>
        <p className="text-xs text-muted-foreground">
          {loading ? "载入中…" : `共 ${tags.length} 个标签 · 可在游戏详情页里给游戏打标签`}
        </p>
        <p className="text-xs text-muted-foreground">
          没有任何游戏使用的标签会在进入本页时自动删除；点击标签整行即可展开使用它的作品。
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-border bg-accent px-3 py-2 text-xs">
          {notice}
        </div>
      ) : null}
      {!loading && !error && targetTagId !== null && !tags.some(tag => tag.id === targetTagId) ? (
        <p role="status" className="rounded-md border border-border bg-accent px-3 py-2 text-xs">
          这个标签已被删除或不再被游戏使用。
        </p>
      ) : null}

      {/* Create ---------------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <p className="text-sm font-medium">新建标签</p>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="名称" className="min-w-48 flex-1">
              <Input
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void create();
                }}
                placeholder="例如：纯爱 / NTR / 汉化"
              />
            </Field>
            <Button loading={creating} onClick={() => void create()}>
              新建
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* List ------------------------------------------------------------ */}
      {!loading && tags.length === 0 ? (
        <EmptyState
          title="还没有标签"
          description="用标签给游戏分类，比如「已汉化」「剧情向」「全年龄」。"
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="hidden items-center gap-3 border-b border-border px-3 py-2 text-xs font-medium text-muted-foreground sm:flex">
            <span className="flex-1">标签</span>
            <span className="w-20 text-right">使用中</span>
            <span className="w-28 text-right">操作</span>
          </div>

          {tags.map((tag) => {
            const editing = editingId === tag.id;
            const used = usageCount.get(tag.id) ?? 0;
            const expanded = expandedTagIds.has(tag.id) && !editing;
            const taggedGames = gamesByTag.get(tag.id) ?? [];
            const panelId = `tag-games-${tag.id}`;

            return (
              <div key={tag.id} className="border-b border-border last:border-b-0">
                {/*
                  The whole row is the toggle. It is a real focusable element with
                  `aria-expanded`/`aria-controls`, while its inner buttons stop the
                  click from bubbling so 编辑/删除 never also flips the panel. The
                  keyboard check ignores events from those buttons and from the
                  rename input.
                */}
                <div
                  id={`tag-${tag.id}`}
                  role={editing ? undefined : "button"}
                  tabIndex={editing ? undefined : 0}
                  aria-current={targetTagId === tag.id ? "location" : undefined}
                  aria-expanded={editing ? undefined : expanded}
                  aria-controls={expanded ? panelId : undefined}
                  title={
                    editing
                      ? undefined
                      : `点击${expanded ? "收起" : "展开"}使用「${t(tag.name)}」的作品`
                  }
                  onClick={() => {
                    if (!editing) toggleExpanded(tag.id);
                  }}
                  onKeyDown={(event) => {
                    if (editing || event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleExpanded(tag.id);
                    }
                  }}
                  className={cn(
                    "flex scroll-mt-4 flex-col gap-3 px-3 py-3 transition-colors sm:flex-row sm:items-center",
                    editing
                      ? ""
                      : "cursor-pointer hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    expanded ? "bg-accent/30" : "",
                    targetTagId === tag.id ? "bg-primary/10 ring-2 ring-inset ring-primary" : "",
                  )}
                >
                  {editing ? (
                    <>
                      <div className="flex flex-1 flex-col gap-2">
                        <Input
                          value={editName}
                          onChange={(event) => setEditName(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") void saveEdit();
                            if (event.key === "Escape") setEditingId(null);
                          }}
                          autoFocus
                        />
                      </div>
                      <div className="flex items-center gap-2 sm:w-28 sm:justify-end">
                        <Button
                          size="sm"
                          loading={savingEdit}
                          onClick={() => void saveEdit()}
                        >
                          保存
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setEditingId(null)}
                        >
                          取消
                        </Button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex min-w-0 flex-1 items-center gap-2">
                        <Badge variant="outline" className="max-w-full">
                          <span className="truncate">{t(tag.name)}</span>
                        </Badge>
                        {targetTagId === tag.id ? <span className="shrink-0 text-xs text-primary">已定位</span> : null}
                        <span
                          aria-hidden="true"
                          className="text-[9px] leading-none text-muted-foreground"
                        >
                          {expanded ? "▲" : "▼"}
                        </span>
                      </div>
                      <span className="text-xs text-muted-foreground sm:w-20 sm:text-right">
                        {used > 0 ? `${used} 部` : "未使用"}
                      </span>
                      <div className="flex items-center gap-2 sm:w-28 sm:justify-end">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(event) => {
                            event.stopPropagation();
                            startEdit(tag);
                          }}
                        >
                          编辑
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:bg-destructive/10"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(tag);
                          }}
                        >
                          删除
                        </Button>
                      </div>
                    </>
                  )}
                </div>

                {expanded ? (
                  <div
                    id={panelId}
                    className="flex flex-col gap-2 border-t border-border/60 bg-accent/20 px-3 py-3"
                  >
                    {taggedGames.length === 0 ? (
                      <p className="text-xs text-muted-foreground">
                        还没有游戏使用这个标签；下次进入本页时它会被自动删除。
                      </p>
                    ) : (
                      <>
                        <p className="text-xs text-muted-foreground">
                          使用该标签的作品（{taggedGames.length}）· 与游戏库相同的展示方式
                        </p>
                        {viewMode === "grid" ? (
                          <div className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
                            {taggedGames.map((game) => (
                              <GameCard
                                key={game.id}
                                game={game}
                                tags={gameTags(game.id)}
                                onToggleFavorite={(target) => void toggleFavorite(target)}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="overflow-hidden rounded-lg border border-border bg-card">
                            {taggedGames.map((game) => (
                              <GameRow
                                key={game.id}
                                game={game}
                                tags={gameTags(game.id)}
                                onToggleFavorite={(target) => void toggleFavorite(target)}
                              />
                            ))}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        busy={deleting}
        title="删除标签？"
        description={
          pendingDelete
            ? (usageCount.get(pendingDelete.id) ?? 0) > 0
              ? `「${pendingDelete.name}」已用于 ${
                  usageCount.get(pendingDelete.id) ?? 0
                } 部游戏。删除后这些游戏的标签关联也会一并移除。`
              : `「${pendingDelete.name}」没有被任何游戏使用。删除后无法恢复。`
            : undefined
        }
        confirmText="删除"
        onConfirm={() => void remove()}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
