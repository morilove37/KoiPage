/**
 * Manual fallback for the metadata dialog.
 *
 * Reached when no provider returns a candidate, when the user does not want to
 * trust upstream data, or when the network is simply unavailable. It writes
 * through the ordinary `game_update` command, so it shares the edit path the
 * detail page already uses and needs no network access at all.
 *
 * Only fields the user actually changed are sent: `game_update` treats an
 * explicit `null` as "clear this column", so submitting untouched empty inputs
 * would wipe existing values.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

import { Button } from "@/components/ui/button";
import { Field, Input, Textarea } from "@/components/ui/input";
import { gameCreate, gameGet, gameSetTags, gameUpdate, tagCreate, tagsList } from "@/lib/db";
import type { Game, GameInput, GameDetail, GamePatch, Tag } from "@/lib/db";
import { formatRating, roundRating } from "@/lib/rating";

import { errorMessage } from "./fields";

export interface ManualEntryFormProps {
  gameId?: number;
  draft?: GameInput;
  onCreated?: (game: Game) => void;
  onSavingChange?: (saving: boolean) => void;
  /** Fired after a write actually happened, so the host can reload its copy. */
  onSaved?: () => void;
  /** Returns to the online search flow; the button is hidden when omitted. */
  onBack?: () => void;
}

/** Every field is a string so the inputs stay controlled and empty-able. */
interface ManualForm {
  title: string;
  originalTitle: string;
  developer: string;
  releaseDate: string;
  rating: string;
  description: string;
  coverPath: string;
  tags: string;
}

const EMPTY_FORM: ManualForm = {
  title: "",
  originalTitle: "",
  developer: "",
  releaseDate: "",
  rating: "",
  description: "",
  coverPath: "",
  tags: "",
};

function toForm(game: GameDetail, tags: Tag[]): ManualForm {
  const names = game.tags
    .map((id) => tags.find((tag) => tag.id === id)?.name)
    .filter((name): name is string => Boolean(name));
  return {
    title: game.title,
    originalTitle: game.originalTitle ?? "",
    developer: game.developer ?? "",
    releaseDate: game.releaseDate ?? "",
    rating: game.rating === null ? "" : formatRating(game.rating),
    description: game.description ?? "",
    coverPath: game.coverPath ?? "",
    tags: names.join("，"),
  };
}

function parseTags(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[,，;；\n]/)) {
    const name = part.trim();
    const key = name.toLocaleLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/** `''` -> null (clears the column); otherwise the trimmed string. */
function orNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** `''` -> null (unrated); accepts finite 0-10 scores, including decimals. */
function parseRating(raw: string): { ok: true; value: number | null } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > 10) return { ok: false };
  return { ok: true, value: roundRating(value) };
}

export function ManualEntryForm({ gameId, draft, onCreated, onSavingChange, onSaved, onBack }: ManualEntryFormProps) {
  const [baseline, setBaseline] = useState<GameDetail | null>(null);
  const [knownTags, setKnownTags] = useState<Tag[]>([]);
  const [form, setForm] = useState<ManualForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Guards the async load/save against a dialog closed mid-flight.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    if (draft) {
      setBaseline(null);
      setForm({
        ...EMPTY_FORM,
        title: draft.title,
        originalTitle: draft.originalTitle ?? "",
        developer: draft.developer ?? "",
        releaseDate: draft.releaseDate ?? "",
        rating: draft.rating == null ? "" : formatRating(draft.rating),
        description: draft.description ?? "",
        coverPath: draft.coverPath ?? "",
        tags: draft.tagNames?.join("，") ?? "",
      });
      setLoading(false);
      return;
    }
    try {
      if (gameId === undefined) throw new Error("缺少游戏记录。");
      const [game, tags] = await Promise.all([gameGet(gameId), tagsList()]);
      if (!aliveRef.current) return;
      setBaseline(game);
      setKnownTags(tags);
      setForm(toForm(game, tags));
    } catch (cause) {
      if (!aliveRef.current) return;
      // Losing the baseline is not fatal for a first-time fill, but the save
      // path must then never send nulls (see `buildPatch`).
      setBaseline(null);
      setForm({ ...EMPTY_FORM });
      setLoadError(
        `读取当前资料失败：${errorMessage(cause)}。可以直接填写，保存时会因同一个原因失败。`,
      );
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [gameId, draft]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Only the changed fields.
   *
   * With a baseline, `null` means "the user emptied this input", which is a
   * real clear request. Without a baseline nothing is known about the row, so
   * only filled-in values are sent — never a null.
   */
  const buildPatch = useCallback(
    (rating: number | null): GamePatch | null => {
      if (!form) return null;
      const patch: GamePatch = {};
      const title = form.title.trim();

      if (!baseline) {
        if (title !== "") patch.title = title;
        if (orNull(form.originalTitle) !== null) patch.originalTitle = orNull(form.originalTitle);
        if (orNull(form.developer) !== null) patch.developer = orNull(form.developer);
        if (orNull(form.releaseDate) !== null) patch.releaseDate = orNull(form.releaseDate);
        if (rating !== null) patch.rating = rating;
        if (orNull(form.description) !== null) patch.description = orNull(form.description);
        if (orNull(form.coverPath) !== null) patch.coverPath = orNull(form.coverPath);
        return patch;
      }

      if (title !== baseline.title) patch.title = title;
      if (orNull(form.originalTitle) !== baseline.originalTitle)
        patch.originalTitle = orNull(form.originalTitle);
      if (orNull(form.developer) !== baseline.developer)
        patch.developer = orNull(form.developer);
      if (orNull(form.releaseDate) !== baseline.releaseDate)
        patch.releaseDate = orNull(form.releaseDate);
      if (rating !== baseline.rating) patch.rating = rating;
      if (orNull(form.description) !== baseline.description)
        patch.description = orNull(form.description);
      if (orNull(form.coverPath) !== baseline.coverPath)
        patch.coverPath = orNull(form.coverPath);

      return patch;
    },
    [form, baseline],
  );

  const save = useCallback(async () => {
    if (!form) return;
    if (form.title.trim() === "") {
      setError("标题不能为空。");
      return;
    }
    const rating = parseRating(form.rating);
    if (!rating.ok) {
      setError("评分必须是 0-10 的数字，支持小数，留空表示未评分。");
      return;
    }

    const patch = buildPatch(rating.value);
    if (!patch) return;
    const wantedTags = parseTags(form.tags);
    const baselineTags = baseline
      ? baseline.tags
          .map((id) => knownTags.find((tag) => tag.id === id)?.name.toLocaleLowerCase())
          .filter((name): name is string => Boolean(name))
          .sort()
      : [];
    const tagsChanged = wantedTags.map((name) => name.toLocaleLowerCase()).sort().join("\n") !== baselineTags.join("\n");
    if (!draft && Object.keys(patch).length === 0 && !tagsChanged) {
      setNotice("没有需要保存的修改。");
      return;
    }

    setSaving(true);
    onSavingChange?.(true);
    setError(null);
    setNotice(null);
    try {
      if (draft) {
        const created = await gameCreate({
          ...draft,
          title: form.title.trim(),
          originalTitle: orNull(form.originalTitle),
          developer: orNull(form.developer),
          releaseDate: orNull(form.releaseDate),
          rating: rating.value,
          coverPath: orNull(form.coverPath),
          description: orNull(form.description),
          tagNames: wantedTags,
        });
        onCreated?.(created);
        return;
      }
      if (gameId === undefined) throw new Error("缺少游戏记录。");
      if (Object.keys(patch).length > 0) await gameUpdate(gameId, patch);
      if (tagsChanged) {
        const currentTags = [...knownTags];
        const ids: number[] = [];
        for (const name of wantedTags) {
          let tag = currentTags.find(
            (item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
          );
          if (!tag) {
            tag = await tagCreate(name);
            currentTags.push(tag);
          }
          ids.push(tag.id);
        }
        await gameSetTags(gameId, ids);
      }
      const [updated, nextTags] = await Promise.all([gameGet(gameId), tagsList()]);
      if (!aliveRef.current) return;
      // Re-sync from the row the command returned so the diff stays honest.
      setBaseline(updated);
      setKnownTags(nextTags);
      setForm(toForm(updated, nextTags));
      setNotice(`已保存${Object.keys(patch).length + (tagsChanged ? 1 : 0)} 个字段。`);
      onSaved?.();
    } catch (cause) {
      if (!aliveRef.current) return;
      setError(errorMessage(cause));
    } finally {
      onSavingChange?.(false);
      if (aliveRef.current) setSaving(false);
    }
  }, [form, buildPatch, gameId, onSaved, baseline, knownTags, draft, onCreated, onSavingChange]);

  const chooseCover = async () => {
    try {
      const path = await open({
        title: "选择游戏封面",
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
      });
      if (typeof path === "string") setForm((value) => value ? { ...value, coverPath: path } : value);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  if (loading) {
    return <div className="py-10 text-center text-sm text-muted-foreground">载入当前资料…</div>;
  }

  if (!form) {
    return (
      <div className="py-10 text-center text-sm text-destructive">
        无法准备手填表单，请关闭后重试。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        {draft ? "没有找到合适的作品，可以在这里填写资料。点击保存后才会加入游戏库。" : "填写资料后保存。清空字段可以移除原有内容。"}
      </p>

      {loadError ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {loadError}
        </div>
      ) : null}
      {error ? (
        <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      {notice ? (
        <div className="rounded-md border border-border bg-accent px-3 py-2 text-xs">{notice}</div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="标题" className="sm:col-span-2">
          <Input
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            disabled={saving}
            placeholder="必填"
          />
        </Field>
        <Field label="原名">
          <Input
            value={form.originalTitle}
            onChange={(event) => setForm({ ...form, originalTitle: event.target.value })}
            disabled={saving}
          />
        </Field>
        <Field label="开发商">
          <Input
            value={form.developer}
            onChange={(event) => setForm({ ...form, developer: event.target.value })}
            disabled={saving}
          />
        </Field>
        <Field label="发售日" hint="任意文本，通常是 YYYY-MM-DD">
          <Input
            value={form.releaseDate}
            onChange={(event) => setForm({ ...form, releaseDate: event.target.value })}
            disabled={saving}
          />
        </Field>
        <Field label="评分" hint="0-10，保留两位小数，留空表示未评分">
          <Input
            type="number"
            min={0}
            max={10}
            step="0.01"
            value={form.rating}
            onChange={(event) => setForm({ ...form, rating: event.target.value })}
            disabled={saving}
            placeholder="留空"
          />
        </Field>
        <Field label="封面路径" className="sm:col-span-2" hint="本地绝对路径，或 http(s) 图片地址">
          <div className="flex items-center gap-2">
          <Input
            value={form.coverPath}
            onChange={(event) => setForm({ ...form, coverPath: event.target.value })}
            disabled={saving}
            spellCheck={false}
            placeholder="E:\Games\Foo\cover.jpg"
          />
          <Button variant="outline" disabled={saving} onClick={() => void chooseCover()}>
            选择图片
          </Button>
          </div>
        </Field>
        <Field label="标签" className="sm:col-span-2" hint="用逗号或换行分隔；不存在的标签会自动创建">
          <Input
            value={form.tags}
            onChange={(event) => setForm({ ...form, tags: event.target.value })}
            disabled={saving}
            placeholder="纯爱，校园，治愈"
          />
        </Field>
        <Field label="简介" className="sm:col-span-2">
          <Textarea
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            disabled={saving}
            className="min-h-28"
          />
        </Field>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        {onBack ? (
          <Button variant="ghost" onClick={onBack} disabled={saving}>
            返回联网搜索
          </Button>
        ) : null}
        <Button onClick={() => void save()} loading={saving} disabled={saving}>
          {draft ? "保存并导入" : "保存资料"}
        </Button>
      </div>
    </div>
  );
}

export default ManualEntryForm;
