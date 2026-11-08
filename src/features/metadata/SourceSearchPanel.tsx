import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { MetadataProvider } from '@/lib/db';
import { PROVIDER_LABELS } from './fields';
import type { SourceSearchState } from './source-search-session';

function failureLabel(message: string | null) {
  if (/Cloudflare|访问验证|验证码/i.test(message ?? '')) return '需要访问验证';
  if (/超时|timed?\s*out|timeout/i.test(message ?? '')) return '请求超时';
  if (/429|限流/.test(message ?? '')) return '请求受限';
  if (/401|403|授权|登录/.test(message ?? '')) return '访问受限';
  return '请求失败';
}

export function SourceSearchPanel({ sources, query, disabled, onRetry }: {
  sources: SourceSearchState[];
  query: string;
  disabled: boolean;
  onRetry: (provider: MetadataProvider) => void;
}) {
  if (!sources.length) return null;
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="各数据源搜索进度">
    {sources.map(source => {
      const pending = source.phase === 'searching';
      const failed = source.phase === 'error';
      const empty = source.phase === 'empty';
      return <div key={source.provider} data-search-source={source.provider} data-search-phase={source.phase}
        className={cn('rounded-xl border px-3 py-2.5', failed ? 'border-amber-500/35 bg-amber-500/5' : 'border-border bg-muted/30')}>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', pending ? 'animate-pulse bg-primary' : failed ? 'bg-amber-500' : empty ? 'bg-muted-foreground' : 'bg-emerald-500')} />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{PROVIDER_LABELS[source.provider]}</span>
          {source.elapsedMs !== null ? <span className="text-[11px] tabular-nums text-muted-foreground">{(source.elapsedMs / 1000).toFixed(1)} 秒</span> : null}
          {failed || empty ? <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" disabled={disabled}
            title={`仅用「${query}」重试 ${PROVIDER_LABELS[source.provider]}`} aria-label={`重试 ${PROVIDER_LABELS[source.provider]}`}
            onClick={() => onRetry(source.provider)}>重试</Button> : null}
        </div>
        <p role="status" className={cn('mt-1 text-xs', failed ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
          {pending ? '正在搜索…' : failed ? failureLabel(source.message) : empty ? '没有找到候选' : `找到 ${source.candidates.length} 个候选`}
        </p>
        {failed ? <p className="mt-1 line-clamp-2 break-words text-[11px] leading-relaxed text-muted-foreground" title={source.message ?? ''}>{source.message}</p> : null}
      </div>;
    })}
  </div>;
}
