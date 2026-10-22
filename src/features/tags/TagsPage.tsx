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

  const [pendingDelete, setPendingDelete] = useState<Tag[] | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const selectedTags = tags.filter(tag => selectedIds.has(tag.id));
  const toggleSelected = (id: number) => setSelectedIds(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
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
    if (!pendingDelete?.length || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    setError(null);
    try {
      const results = await Promise.allSettled(pendingDelete.map(tag => tagDelete(tag.id)));
      const removed = new Set(pendingDelete.filter((_, i) => results[i].status === 'fulfilled').map(tag => tag.id));
      const failed = pendingDelete.filter(tag => !removed.has(tag.id));
      setTags(current => current.filter(tag => !removed.has(tag.id)));
      setLinks(current => current.filter(([, tagId]) => !removed.has(tagId)));
      setSelectedIds(current => new Set([...current].filter(id => !removed.has(id))));
      setExpandedTagIds(current => new Set([...current].filter(id => !removed.has(id))));
      if (removed.size) setNotice(`已删除 ${removed.size} 个标签，游戏和游玩记录保留。`);
      if (failed.length) {
        setPendingDelete(failed);
        setDeleteError(`${failed.length} 个标签删除失败，可重试：${summariseNames(failed.map(tag => t(tag.name)))}`);
      } else {
        setPendingDelete(null);
        setSelecting(false);
      }
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

      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-3" data-tag-selection>
        <Button size="sm" variant="outline" disabled={loading || deleting || !tags.length || creating || savingEdit} aria-pressed={selecting} onClick={() => {
          setSelecting(!selecting); setSelectedIds(new Set()); setEditingId(null);
        }}>{selecting ? '取消多选' : '多选删除'}</Button>
        {selecting && <>
          <span className="text-xs text-muted-foreground">已选 {selectedTags.length} / {tags.length} 个标签</span>
          <Button size="sm" variant="ghost" disabled={deleting} onClick={() => setSelectedIds(new Set(tags.map(tag => tag.id)))}>全选</Button>
          <Button size="sm" variant="ghost" disabled={deleting || !selectedTags.length} onClick={() => setSelectedIds(new Set())}>清空选择</Button>
          <Button size="sm" variant="destructive" disabled={deleting || !selectedTags.length} onClick={() => { setDeleteError(null); setPendingDelete(selectedTags); }}>删除选中（{selectedTags.length}）</Button>
        </>}
      </div>

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
            const expanded = expandedTagIds.has(tag.id) && !editing && !selecting;
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
                  aria-expanded={editing || selecting ? undefined : expanded}
                  aria-pressed={selecting ? selectedIds.has(tag.id) : undefined}
                  aria-controls={expanded ? panelId : undefined}
                  title={
                    editing
                      ? undefined
                      : selecting ? `选择「${t(tag.name)}」` : `点击${expanded ? "收起" : "展开"}使用「${t(tag.name)}」的作品`
                  }
                  onClick={() => {
                    if (!editing && !deleting) { if (selecting) toggleSelected(tag.id); else toggleExpanded(tag.id); }
                  }}
                  onKeyDown={(event) => {
                    if (editing || event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      if (!deleting) { if (selecting) toggleSelected(tag.id); else toggleExpanded(tag.id); }
                    }
                  }}
                  className={cn(
                    "flex scroll-mt-4 flex-col gap-3 px-3 py-3 transition-colors sm:flex-row sm:items-center",
                    editing
                      ? ""
                      : "cursor-pointer hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                    expanded ? "bg-accent/30" : "",
                    selecting && selectedIds.has(tag.id) ? "bg-primary/10 ring-1 ring-inset ring-primary/50" : "",
                    targetTagId === tag.id ? "bg-primary/10 ring-2 ring-inset ring-primary" : "",
                  )}
                >
                  {selecting && <input type="checkbox" className="size-4 shrink-0 accent-primary" checked={selectedIds.has(tag.id)} disabled={deleting}
                    aria-label={`选择标签「${t(tag.name)}」`} onClick={event => event.stopPropagation()} onChange={() => toggleSelected(tag.id)} />}
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
                          disabled={selecting || deleting}
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
                          disabled={selecting || deleting}
                          onClick={(event) => {
                            event.stopPropagation();
                            setDeleteError(null); setPendingDelete([tag]);
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
        title={pendingDelete && pendingDelete.length > 1 ? `删除 ${pendingDelete.length} 个标签？` : '删除标签？'}
        description={pendingDelete ? <div className="space-y-2">
          <p>将删除 {pendingDelete.length} 个标签：{summariseNames(pendingDelete.map(tag => t(tag.name)), 12)}。</p>
          <p>这些标签与游戏的关联会一并移除，游戏和游玩记录保留。删除后无法恢复。</p>
          {deleteError && <p role="alert" className="text-destructive">{deleteError}</p>}
        </div> : undefined}
        confirmText={deleting ? '删除中…' : '确定删除'}
        onConfirm={() => void remove()}
        onCancel={() => { if (!deleting) setPendingDelete(null); }}
      />
    </div>
  );
}
