/**
 * Field catalogue and pure helpers shared by the metadata dialog and its
 * manual ("no provider knows this work") fallback.
 *
 * Kept free of React and of `@/lib/db`'s runtime side so both components can
 * import it without pulling the database connection in twice.
 */

import type {
  MetadataDetail,
  MetadataField,
  MetadataProvider,
} from "@/lib/db";
import type { GameInput } from "@/types/game";
import { formatRating, roundRating } from "@/lib/rating";

/** Copy the accepted fields onto the draft (its title is already resolved). */
export function metadataInput(
  draft: GameInput,
  detail: MetadataDetail,
  fields: readonly MetadataField[],
  useCover: boolean,
): GameInput {
  const input: GameInput = { ...draft, title: draft.title.trim() };
  for (const field of fields) {
    if (!hasFieldData(detail, field)) continue;
    switch (field) {
      case "title": break; // The caller has already resolved the draft's title.
      case "original_title": input.originalTitle = detail.titleOriginal; break;
      case "developer": input.developer = detail.developer; break;
      case "release_date": input.releaseDate = detail.releaseDate; break;
      case "description": input.description = detail.description; break;
      case "rating": input.rating = detail.rating === null ? null : roundRating(detail.rating); break;
      case "vndb_id": input.vndbId = detail.vndbId; break;
      case "bangumi_id": input.bangumiId = detail.bangumiId; break;
      case "tags": input.tagNames = detail.tags; break;
    }
  }
  if (useCover && detail.coverUrl) input.coverPath = detail.coverUrl;
  return input;
}

/** Every source `metadata_search` accepts, in display order. */
export const ALL_PROVIDERS: readonly MetadataProvider[] = ["nextmoe", "vndb", "bangumi", "2dfan"];

/**
 * Display names for the sources.
 *
 * `nextmoe` must read "鲲 Galgame 论坛": that is the credit NextMoe's terms
 * require for its Galgame data, and it is also what `sourceLabel` carries.
 */
export const PROVIDER_LABELS: Record<MetadataProvider, string> = {
  nextmoe: "鲲 Galgame 论坛",
  vndb: "VNDB",
  bangumi: "Bangumi",
  '2dfan': "2DFan",
};

export function providerLabel(provider: MetadataProvider | null | undefined): string {
  return provider === null || provider === undefined ? "未知来源" : PROVIDER_LABELS[provider];
}

/**
 * `metadata_apply` field names, ordered as the confirmation list renders them.
 *
 * This order is the UI's; the command accepts any subset in any order.
 */
export const FIELD_ORDER: readonly MetadataField[] = [
  "title",
  "original_title",
  "developer",
  "release_date",
  "rating",
  "description",
  "tags",
  "vndb_id",
  "bangumi_id",
];

export const FIELD_LABELS: Record<MetadataField, string> = {
  title: "游戏名",
  original_title: "原名",
  developer: "开发商",
  release_date: "发售日",
  rating: "评分（0-10）",
  description: "简介",
  tags: "标签",
  vndb_id: "VNDB ID",
  bangumi_id: "Bangumi ID",
};

/** Hints shown for fields that usually deserve a second look. */
export const FIELD_NOTES: Partial<Record<MetadataField, string>> = {
  title: "按设置中的标题语言选择名称，默认优先采用中文名，其次日文原名、数据源标题；搜索名称仅在资料没有标题时使用。",
  rating: "上游评分归一到 0-10，四舍五入到小数点后两位。",
  tags: "按名称入库，同名标签会复用而不是重建。",
};

/** Which language metadata confirmation and auto-fetch prefer for the game name. */
export type MetadataTitlePreference = "zh" | "ja" | "source";

/** Settings key shared with Rust (`metadata::TITLE_LANGUAGE_KEY`). */
export const TITLE_LANGUAGE_KEY = "metadata_title_language";

/** Parse the stored setting; unknown values fall back to Chinese-first. */
export function normalizeTitlePreference(value: string | null | undefined): MetadataTitlePreference {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (trimmed === "ja") return "ja";
  if (trimmed === "source") return "source";
  return "zh";
}

/**
 * The display title a merged detail resolves to.
 *
 * Mirrors `metadata::resolve_title` in Rust: VNDB's primary `title` is often
 * romanised, so it is only the last resort unless the user explicitly opts into
 * source titles.
 */
export function titleFor(
  detail: MetadataDetail,
  preference: MetadataTitlePreference = "zh",
): string {
  const zh = detail.titleZh?.trim() ?? "";
  const original = detail.titleOriginal?.trim() ?? "";
  const source = detail.title.trim();
  const order =
    preference === "ja" ? [original, zh, source]
    : preference === "source" ? [source, zh, original]
    : [zh, original, source];
  return order.find((value) => value !== "") ?? "";
}/**
 * Whether the detail carries a value for `field` at all.
 *
 * Load-bearing: `metadata_apply` writes null for a listed field whose upstream
 * value is missing, so the dialog must not pre-check — let alone silently
 * submit — a field that has no data.
 */
export function hasFieldData(detail: MetadataDetail, field: MetadataField): boolean {
  switch (field) {
    case "title":
      return titleFor(detail) !== "";
    case "original_title":
      return isPresent(detail.titleOriginal);
    case "developer":
      return isPresent(detail.developer);
    case "release_date":
      return isPresent(detail.releaseDate);
    case "rating":
      return detail.rating !== null && Number.isFinite(detail.rating);
    case "description":
      return isPresent(detail.description);
    case "tags":
      return detail.tags.length > 0;
    case "vndb_id":
      return isPresent(detail.vndbId);
    case "bangumi_id":
      return isPresent(detail.bangumiId);
  }
}

/** The value preview rendered beside a field's checkbox. */
export function fieldPreview(detail: MetadataDetail, field: MetadataField): string {
  switch (field) {
    case "title":
      // `metadata_apply` writes this value verbatim for a manual confirmation
      // (the dialog has already resolved the preferred language into `title`).
      return detail.title.trim();
    case "original_title":
      return detail.titleOriginal?.trim() ?? "";
    case "developer":
      return detail.developer?.trim() ?? "";
    case "release_date":
      return detail.releaseDate?.trim() ?? "";
    case "rating":
      return detail.rating === null ? "" : formatRating(detail.rating);
    case "description":
      return detail.description?.trim() ?? "";
    case "tags":
      return detail.tags.join("、");
    case "vndb_id":
      return detail.vndbId?.trim() ?? "";
    case "bangumi_id":
      return detail.bangumiId?.trim() ?? "";
  }
}

/**
 * Initial checkbox state for a freshly loaded detail.
 *
 * Every field that actually carries data starts checked — that is the "默认全
 * 勾" the flow promises. Fields with no upstream value start *unchecked*
 * because submitting them would clear the column the user already curated.
 */
export function defaultChecked(detail: MetadataDetail): Record<MetadataField, boolean> {
  const state = {} as Record<MetadataField, boolean>;
  for (const field of FIELD_ORDER) state[field] = hasFieldData(detail, field);
  return state;
}

/** Two decimal places, or an em dash for a non-finite score. */
export function formatScore(score: number): string {
  return formatRating(score);
}

/**
 * Display names for `SourceRating.source`.
 *
 * Rust forwards the upstream's own lowercase id verbatim (`vndb.rs` uses
 * `"vndb"`, and NextMoe passes through whatever `/works/:id/ratings` returned),
 * so the raw value is not fit to print.
 */
const SOURCE_LABELS: Record<string, string> = {
  '2dfan': "2DFan",
  vndb: "VNDB",
  bangumi: "Bangumi",
  nextmoe: "鲲 Galgame 论坛",
  erogamescape: "ErogameScape",
  howlongtobeat: "HowLongToBeat",
  dlsite: "DLsite",
  getchu: "Getchu",
  "ci-en": "Ci-en",
  ci_en: "Ci-en",
  steam: "Steam",
};

export function sourceRatingLabel(source: string): string {
  const key = source.trim().toLowerCase();
  if (key === "") return "未知来源";
  // Unknown ids are shown as-is rather than hidden: a new upstream showing up
  // is information, not noise.
  return SOURCE_LABELS[key] ?? source;
}

/** `VNDB 8.7（11487 票）` — one entry of the multi-source rating line. */
export function formatSourceRating(rating: {
  source: string;
  score: number;
  voteCount: number | null;
}): string {
  const votes =
    rating.voteCount !== null && rating.voteCount !== undefined && rating.voteCount > 0
      ? `（${rating.voteCount} 票）`
      : "";
  return `${sourceRatingLabel(rating.source)} ${formatScore(rating.score)}${votes}`;
}

/**
 * Rust rejects with a plain string (`CmdError` serialises as `str`), not an
 * `Error`, so both shapes have to be handled. Same idiom as the rest of the
 * codebase.
 */
export function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isPresent(value: string | null | undefined): boolean {
  return value !== null && value !== undefined && value.trim() !== "";
}
