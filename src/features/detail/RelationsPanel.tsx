import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/features/io/io";
import { invoke } from "@/lib/logging";
import { useProtectedCover } from "@/lib/protected-cover";
import { cn } from "@/lib/utils";

export interface RelationsPanelProps {
  vndbId: string | null;
  onOpenUrl?: (url: string) => void;
  /** Jump to the local game when the related work is already in the library. */
  onOpenGame?: (gameId: number) => void;
}

/** One related work as reported by a metadata provider. */
interface MetadataRelation {
  provider: string;
  externalId: string;
  relation: string;
  relationLabel: string;
  title: string;
  originalTitle?: string | null;
  releaseDate?: string | null;
  rating?: number | null;
  coverUrl?: string | null;
  url: string;
  /** Set when the related work is already in the library. */
  libraryGameId?: number | null;
}

interface RelationGroup {
  label: string;
  items: MetadataRelation[];
}

/** One decimal is enough for a 0-10 score; anything else renders as a dash. */
function formatRelationRating(rating: number | null | undefined): string {
  return typeof rating === "number" && Number.isFinite(rating) ? rating.toFixed(1) : "—";
}

/** Display label for one relation, falling back to the raw relation key. */
function relationLabelOf(relation: MetadataRelation): string {
  // Typed as required, but an older provider payload may still omit it.
  const label: string | null | undefined = relation.relationLabel;
  const trimmed = label?.trim() ?? "";
  if (trimmed) return trimmed;
  const key: string | null | undefined = relation.relation;
  const trimmedKey = key?.trim() ?? "";
  return trimmedKey || "关联作品";
}

/**
 * Group relations by their human-readable label, keeping the provider's order.
 *
 * A `Map` preserves insertion order, so the first label seen stays the first
 * group heading; the entries themselves keep their relative order too.
 */
function groupRelations(relations: MetadataRelation[]): RelationGroup[] {
  const groups = new Map<string, MetadataRelation[]>();
  for (const relation of relations) {
    const label = relationLabelOf(relation);
    const bucket = groups.get(label);
    if (bucket) bucket.push(relation);
    else groups.set(label, [relation]);
  }
  return Array.from(groups, ([label, items]) => ({ label, items }));
}

export function RelationsPanel({ vndbId, onOpenUrl, onOpenGame }: RelationsPanelProps) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>关联作品</CardTitle>
      </CardHeader>
      <CardContent>
        {vndbId
          ? <RelationList key={vndbId} vndbId={vndbId} onOpenUrl={onOpenUrl} onOpenGame={onOpenGame} />
          : <p className="text-xs leading-relaxed text-muted-foreground">这个游戏还没有关联 VNDB 条目，先在资料匹配中应用一次 VNDB 数据。</p>}
      </CardContent>
    </Card>
  );
}

interface RelationListProps {
  vndbId: string;
  onOpenUrl?: (url: string) => void;
  onOpenGame?: (gameId: number) => void;
}

function RelationList({ vndbId, onOpenUrl, onOpenGame }: RelationListProps) {
  const [relations, setRelations] = useState<MetadataRelation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const alive = useRef(false);
  const version = useRef(0);

  const load = useCallback(async (refresh = false): Promise<void> => {
    const current = ++version.current;
    setLoading(true);
    setError("");
    try {
      const list = await invoke<MetadataRelation[]>("metadata_relations", { provider: "vndb", externalId: vndbId, refresh });
      if (alive.current && version.current === current) setRelations(Array.isArray(list) ? list : []);
    } catch (cause) {
      if (alive.current && version.current === current) { setRelations([]); setError(errorMessage(cause)); }
    } finally {
      if (alive.current && version.current === current) setLoading(false);
    }
  }, [vndbId]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => { alive.current = false; version.current++; };
  }, [load]);

  const groups = useMemo(() => groupRelations(relations), [relations]);

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <p role="status" className="text-xs text-muted-foreground">正在加载关联作品…</p>
        <div aria-hidden className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map(index => (
            <div key={index} className="flex gap-3 rounded-lg border border-border p-3">
              <Skeleton variant="shimmer" className="h-[88px] w-16 shrink-0 rounded" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-4/5" />
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-2/3" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="alert" className="break-all text-xs leading-relaxed text-destructive">{error}</p>
        <Button type="button" size="sm" variant="outline" onClick={() => void load(true)}>重试</Button>
      </div>
    );
  }

  if (relations.length === 0) {
    return <p className="text-xs leading-relaxed text-muted-foreground">这个 VNDB 条目没有关联作品。</p>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-relaxed text-muted-foreground">
          {onOpenUrl ? "来自 VNDB 的关联作品，库中已有的作品可以直接跳转，其余在浏览器中打开。" : "来自 VNDB 的关联作品。"}
        </p>
        <Button type="button" size="sm" variant="outline" onClick={() => void load(true)}>刷新</Button>
      </div>
      {groups.map(group => (
        <section key={group.label} className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{group.label} · {group.items.length}</h4>
          <div className="grid gap-3 sm:grid-cols-2">
            {group.items.map(relation => (
              <RelationCard
                key={`${relation.provider}:${relation.externalId}:${relation.relation}`}
                relation={relation}
                onOpenUrl={onOpenUrl}
                onOpenGame={onOpenGame}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

interface RelationCardProps {
  relation: MetadataRelation;
  onOpenUrl?: (url: string) => void;
  onOpenGame?: (gameId: number) => void;
}

const CARD_CLASS = "flex min-w-0 items-start gap-3 rounded-lg border border-border p-3 text-left";

function RelationCard({ relation, onOpenUrl, onOpenGame }: RelationCardProps) {
  const originalTitle = relation.originalTitle?.trim() ?? "";
  // A library hit is the more useful action, so it wins over opening VNDB.
  const libraryGameId = typeof relation.libraryGameId === "number" ? relation.libraryGameId : null;
  const action = libraryGameId !== null && onOpenGame
    ? { run: () => onOpenGame(libraryGameId), hint: `在游戏库中打开：${relation.title}` }
    : onOpenUrl
      ? { run: () => onOpenUrl(relation.url), hint: `在浏览器中打开：${relation.title}` }
      : null;
  const body = (
    <>
      <RelationCover src={relation.coverUrl ?? null} alt={relation.title} />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-medium leading-snug">{relation.title}</p>
        {originalTitle && originalTitle !== relation.title ? (
          <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{originalTitle}</p>
        ) : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <Badge variant="outline">{relationLabelOf(relation)}</Badge>
          {libraryGameId !== null ? <Badge variant="secondary">已在库中</Badge> : null}
          {relation.releaseDate ? <span className="text-[11px] text-muted-foreground">{relation.releaseDate}</span> : null}
          <span className="text-[11px] tabular-nums text-muted-foreground">评分 {formatRelationRating(relation.rating)}</span>
        </div>
      </div>
    </>
  );
  // The whole card is the click target; when no handler is supplied the click
  // is simply a no-op and the card shows no hover affordance.
  return (
    <button
      type="button"
      title={action?.hint}
      onClick={() => action?.run()}
      className={cn(CARD_CLASS, action ? "tap hover:border-primary/50 hover:bg-accent" : "cursor-default")}
    >
      {body}
    </button>
  );
}

/** 64x88 thumbnail; falls back to a placeholder when the cover is missing. */
function RelationCover({ src, alt }: { src: string | null; alt: string }) {
  const resolved = useProtectedCover(src ?? undefined);
  return (
    <div className="h-[88px] w-16 shrink-0 overflow-hidden rounded bg-muted">
      {resolved.src
        ? <img src={resolved.src} alt={alt} loading="lazy" className="h-full w-full object-cover" />
        : <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] leading-tight text-muted-foreground">{resolved.pending ? "载入…" : "无封面"}</div>}
    </div>
  );
}
