import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { errorMessage } from "@/features/io/io";
import { invoke } from "@/lib/logging";
import { useProtectedCover } from "@/lib/protected-cover";

export interface GuidePanelProps {
  gameId: number;
  twodfanId: string | null;
  onBindSubject: (subjectId: string) => void;
  onOpenUrl?: (url: string) => void;
}

/** One 2DFan topic as listed for a bound subject. */
interface TwodfanTopic {
  topicId: number;
  kind: string | null;
  title: string;
  author: string | null;
  publishedAt: string | null;
  url: string;
}

type TopicBlockKind = "paragraph" | "line" | "table" | "image" | "heading";

/**
 * One rendered piece of a topic body.
 *
 * Every payload field is optional: the scraper emits `text` for prose blocks,
 * `src` for images and `rows` for tables, so each kind has to tolerate the
 * other two being absent.
 */
interface TopicBlock {
  kind: TopicBlockKind;
  text?: string | null;
  src?: string | null;
  rows?: string[][] | null;
}

interface TwodfanTopicContent {
  topicId: number;
  title: string;
  author: string | null;
  publishedAt: string | null;
  url: string;
  pageCount: number;
  blocks: TopicBlock[];
}

interface TwodfanCandidate {
  externalId: string;
  title: string;
  originalTitle: string | null;
  releaseDate: string | null;
  coverUrl: string | null;
}

interface TwodfanSearchResult {
  candidates: TwodfanCandidate[];
}

/** Reply from `twodfan_autobind`. */
interface AutobindResult {
  subjectId: string | null;
  title: string | null;
  reason: string | null;
  /** True when 2DFan could not be reached at all, rather than "no match". */
  transportError?: boolean;
}

/**
 * Shown whenever a 2DFan request fails outright.
 *
 * 2DFan is frequently unreachable from mainland networks, and the failure looks
 * identical to "the title has no match", so the user needs the one action that
 * actually helps: retry behind a proxy.
 */
function ProxyHint() {
  return (
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      如果一直搜索失败，通常是 2DFan 在当前网络下无法直连：开启代理后再试，或先在浏览器打开 2dfan.com 确认能否访问。
    </p>
  );
}

/** `author · publishedAt`, omitting whichever side is missing. */
function topicMeta(item: { author: string | null; publishedAt: string | null }): string {
  const author = item.author?.trim() ?? "";
  const published = item.publishedAt ? formatTimestamp(item.publishedAt) : "";
  return [author, published].filter(part => part.length > 0).join(" · ");
}

/**
 * Reformat a scraped timestamp for display.
 *
 * 2DFan sometimes yields a bare date (`2024-05-01`) and sometimes a full ISO
 * instant; only the latter is re-formatted, so a date-only value never gains a
 * bogus midnight-plus-timezone clock time.
 */
function formatTimestamp(value: string): string {
  if (!value.includes("T") && !value.includes(":")) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}

export function GuidePanel({ gameId, twodfanId, onBindSubject, onOpenUrl }: GuidePanelProps) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>2DFan 攻略</CardTitle>
      </CardHeader>
      <CardContent>
        {twodfanId
          ? <BoundTopics key={`${gameId}:${twodfanId}`} gameId={gameId} onOpenUrl={onOpenUrl} />
          : <SubjectSearch key={gameId} gameId={gameId} onBindSubject={onBindSubject} />}
      </CardContent>
    </Card>
  );
}

interface BoundTopicsProps {
  gameId: number;
  onOpenUrl?: (url: string) => void;
}

/** Bound subject: the topic list, with the body of one topic expanded inline. */
function BoundTopics({ gameId, onOpenUrl }: BoundTopicsProps) {
  const [topics, setTopics] = useState<TwodfanTopic[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openTopicId, setOpenTopicId] = useState<number | null>(null);
  const [content, setContent] = useState<TwodfanTopicContent | null>(null);
  const [contentLoading, setContentLoading] = useState(false);
  const [contentError, setContentError] = useState("");
  const alive = useRef(false);
  const listVersion = useRef(0);
  const contentVersion = useRef(0);

  const loadTopics = useCallback(async (): Promise<void> => {
    const version = ++listVersion.current;
    setLoading(true);
    setError("");
    try {
      const list = await invoke<TwodfanTopic[]>("twodfan_topics_list", { gameId });
      if (alive.current && listVersion.current === version) setTopics(Array.isArray(list) ? list : []);
    } catch (cause) {
      if (alive.current && listVersion.current === version) { setTopics([]); setError(errorMessage(cause)); }
    } finally {
      if (alive.current && listVersion.current === version) setLoading(false);
    }
  }, [gameId]);

  const loadContent = useCallback(async (topicId: number): Promise<void> => {
    const version = ++contentVersion.current;
    setContentLoading(true);
    setContentError("");
    setContent(null);
    try {
      const read = await invoke<TwodfanTopicContent>("twodfan_topic_read", { topicId });
      if (alive.current && contentVersion.current === version) setContent(read);
    } catch (cause) {
      if (alive.current && contentVersion.current === version) setContentError(errorMessage(cause));
    } finally {
      if (alive.current && contentVersion.current === version) setContentLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void loadTopics();
    return () => { alive.current = false; listVersion.current++; contentVersion.current++; };
  }, [loadTopics]);

  function toggleTopic(topicId: number): void {
    if (openTopicId === topicId) {
      contentVersion.current++;
      setOpenTopicId(null);
      setContent(null);
      setContentError("");
      setContentLoading(false);
      return;
    }
    setOpenTopicId(topicId);
    void loadContent(topicId);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs leading-relaxed text-muted-foreground">来自 2DFan 的攻略帖子，点击条目在此展开正文。</p>
        <Button type="button" size="sm" variant="outline" disabled={loading} onClick={() => void loadTopics()}>刷新</Button>
      </div>
      {loading ? <TopicListSkeleton /> : null}
      {!loading && error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="break-all text-xs leading-relaxed text-destructive">{error}</p>
          <Button type="button" size="sm" variant="outline" onClick={() => void loadTopics()}>重试</Button>
        </div>
      ) : null}
      {!loading && error ? <ProxyHint /> : null}
      {!loading && !error && topics.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">这个游戏在 2DFan 还没有攻略帖子。</p>
      ) : null}
      {!loading && !error && topics.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {topics.map(topic => {
            const expanded = openTopicId === topic.topicId;
            const meta = topicMeta(topic);
            return (
              <li key={topic.topicId} className="rounded-lg border border-border">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleTopic(topic.topicId)}
                  className="flex w-full flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-left tap hover:bg-accent"
                >
                  {topic.kind ? <Badge variant="secondary">{topic.kind}</Badge> : null}
                  <span className="min-w-0 flex-1 break-words text-sm font-medium">{topic.title}</span>
                  {meta ? <span className="text-[11px] text-muted-foreground">{meta}</span> : null}
                </button>
                {expanded ? (
                  <div className="border-t border-border px-3 py-3">
                    {contentLoading ? <p role="status" className="text-xs text-muted-foreground">正在加载正文…</p> : null}
                    {contentError ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <p role="alert" className="break-all text-xs leading-relaxed text-destructive">{contentError}</p>
                        <Button type="button" size="sm" variant="outline" onClick={() => void loadContent(topic.topicId)}>重试</Button>
                      </div>
                    ) : null}
                    {contentError ? <ProxyHint /> : null}
                    {content && !contentLoading ? (
                      <div className="flex flex-col gap-3">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="text-[11px] text-muted-foreground">
                            {[topicMeta(content), content.pageCount > 0 ? `共 ${content.pageCount} 页` : ""].filter(part => part.length > 0).join(" · ")}
                          </p>
                          {onOpenUrl ? (
                            <Button type="button" size="sm" variant="ghost" onClick={() => onOpenUrl?.(content.url)}>在 2DFan 打开</Button>
                          ) : null}
                        </div>
                        <TopicBlocks blocks={content.blocks ?? []} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

interface SubjectSearchProps {
  gameId: number;
  onBindSubject: (subjectId: string) => void;
}

/**
 * Unbound game: try to bind automatically, then fall back to a manual search.
 *
 * The automatic attempt runs once per mount. It is deliberately silent about
 * progress beyond one status line — when 2DFan is unreachable the command
 * returns a reason and the manual search stays available, which is the only
 * thing the user can act on anyway.
 */
function SubjectSearch({ gameId, onBindSubject }: SubjectSearchProps) {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [results, setResults] = useState<TwodfanCandidate[]>([]);
  const [error, setError] = useState("");
  const [autoState, setAutoState] = useState<"running" | "bound" | "skipped">("running");
  const [autoReason, setAutoReason] = useState("");
  const [autoUnreachable, setAutoUnreachable] = useState(false);
  const alive = useRef(false);
  const searchVersion = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; searchVersion.current++; };
  }, []);

  useEffect(() => {
    let current = true;
    void (async () => {
      try {
        const result = await invoke<AutobindResult>("twodfan_autobind", { gameId });
        if (!current || !alive.current) return;
        if (result.subjectId) {
          setAutoState("bound");
          onBindSubject(result.subjectId);
          return;
        }
        setAutoState("skipped");
        setAutoReason(result.reason ?? "");
        setAutoUnreachable(result.transportError === true);
      } catch (cause) {
        if (!current || !alive.current) return;
        setAutoState("skipped");
        setAutoReason(errorMessage(cause));
        setAutoUnreachable(true);
      }
    })();
    return () => { current = false; };
  }, [gameId, onBindSubject]);

  /** Re-run auto-binding on demand, ignoring the cooldown a previous miss set. */
  const retryAutobind = useCallback(async (): Promise<void> => {
    setAutoState("running");
    setAutoReason("");
    setAutoUnreachable(false);
    try {
      const result = await invoke<AutobindResult>("twodfan_autobind", { gameId, force: true });
      if (!alive.current) return;
      if (result.subjectId) {
        setAutoState("bound");
        onBindSubject(result.subjectId);
        return;
      }
      setAutoState("skipped");
      setAutoReason(result.reason ?? "");
      setAutoUnreachable(result.transportError === true);
    } catch (cause) {
      if (!alive.current) return;
      setAutoState("skipped");
      setAutoReason(errorMessage(cause));
      setAutoUnreachable(true);
    }
  }, [gameId, onBindSubject]);

  const search = useCallback(async (): Promise<void> => {
    const keyword = query.trim();
    if (!keyword) return;
    const version = ++searchVersion.current;
    setSearching(true);
    setError("");
    try {
      const result = await invoke<TwodfanSearchResult>("metadata_search", { query: keyword, sources: ["2dfan"], limit: 10 });
      if (alive.current && searchVersion.current === version) {
        setResults(Array.isArray(result?.candidates) ? result.candidates : []);
        setSearched(true);
      }
    } catch (cause) {
      if (alive.current && searchVersion.current === version) {
        setResults([]);
        setSearched(true);
        setError(errorMessage(cause));
      }
    } finally {
      if (alive.current && searchVersion.current === version) setSearching(false);
    }
  }, [query]);

  const trimmed = query.trim();
  return (
    <div className="flex flex-col gap-3">
      {autoState === "running" ? (
        <p role="status" className="text-xs leading-relaxed text-muted-foreground">正在自动匹配 2DFan 作品…</p>
      ) : null}
      {autoState === "skipped" ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 break-all text-xs leading-relaxed text-muted-foreground">
              {autoReason || "没有自动匹配到 2DFan 作品。"}也可以在下面手动搜索绑定。
            </p>
            <Button type="button" size="sm" variant="outline" onClick={() => void retryAutobind()}>重新自动匹配</Button>
          </div>
          {autoUnreachable ? <ProxyHint /> : null}
        </div>
      ) : null}
      <p className="text-xs leading-relaxed text-muted-foreground">绑定后可以在这里直接阅读攻略帖子。搜索 2DFan 的作品标题，点击结果完成绑定。</p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); void search(); }}>
        <Input
          className="w-auto min-w-0 flex-1"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="输入 2DFan 作品标题"
          aria-label="2DFan 作品标题"
        />
        <Button type="submit" size="sm" loading={searching} disabled={!trimmed}>搜索</Button>
      </form>
      {searching ? <p role="status" className="text-xs text-muted-foreground">正在搜索 2DFan…</p> : null}
      {error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="break-all text-xs leading-relaxed text-destructive">{error}</p>
          <Button type="button" size="sm" variant="outline" disabled={!trimmed || searching} onClick={() => void search()}>重试</Button>
        </div>
      ) : null}
      {error ? <ProxyHint /> : null}
      {!searching && searched && !error && results.length === 0 ? (
        <p className="text-xs leading-relaxed text-muted-foreground">没有找到匹配的 2DFan 作品，换个标题再试试。</p>
      ) : null}
      {results.length > 0 ? (
        <>
          <ul className="flex max-h-72 flex-col gap-1.5 overflow-y-auto pr-1">
            {results.map(candidate => (
              <li key={candidate.externalId}>
                <button
                  type="button"
                  onClick={() => onBindSubject(candidate.externalId)}
                  className="flex w-full flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-left tap hover:border-primary/50 hover:bg-accent"
                >
                  <span className="min-w-0 flex-1 break-words text-sm font-medium">{candidate.title}</span>
                  {candidate.releaseDate ? <span className="text-[11px] text-muted-foreground">{candidate.releaseDate}</span> : null}
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-muted-foreground">点击结果会把该 2DFan 作品绑定到当前游戏。</p>
        </>
      ) : null}
    </div>
  );
}

/** Renders the parsed body blocks of one topic. */
function TopicBlocks({ blocks }: { blocks: TopicBlock[] }) {
  if (blocks.length === 0) {
    return <p className="text-xs text-muted-foreground">这篇帖子没有可显示的正文内容。</p>;
  }
  return (
    <div className="flex flex-col gap-2 text-sm leading-relaxed">
      {blocks.map((block, index) => <TopicBlockView key={index} block={block} />)}
    </div>
  );
}

function TopicBlockView({ block }: { block: TopicBlock }) {
  switch (block.kind) {
    case "paragraph":
      return <p className="break-words">{block.text ?? ""}</p>;
    case "heading":
      return <p className="break-words text-sm font-semibold">{block.text ?? ""}</p>;
    case "line":
      return <p className="my-0.5 break-words">{block.text ?? ""}</p>;
    case "image":
      return <BlockImage src={block.src ?? null} />;
    case "table":
      return <BlockTable rows={block.rows ?? null} />;
    default:
      // Unknown kinds are dropped rather than rendered as raw markup.
      return null;
  }
}

/** 2DFan's CDN needs its site as Referer, so images go through the local cache. */
function BlockImage({ src }: { src: string | null }) {
  const resolved = useProtectedCover(src ?? undefined);
  if (!resolved.src) {
    return <p className="text-xs text-muted-foreground">{resolved.pending ? "正在加载图片…" : "图片无法显示。"}</p>;
  }
  return <img src={resolved.src} alt="帖子配图" loading="lazy" className="max-w-full rounded" />;
}

/** First row is the header; the rest are body rows. */
function BlockTable({ rows }: { rows: string[][] | null }) {
  if (!rows || rows.length === 0) return null;
  const [head, ...body] = rows;
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index} className="border border-border px-2 py-1 text-left font-medium">{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="border border-border px-2 py-1 align-top">{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopicListSkeleton() {
  return (
    <div aria-hidden className="flex flex-col gap-2">
      {[0, 1, 2].map(index => (
        <div key={index} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2.5">
          <Skeleton className="h-5 w-12 rounded-full" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3 w-20" />
        </div>
      ))}
    </div>
  );
}
