import { Button } from '@/components/ui/button';
import type { SyncItem } from './api';
import { valueLabel } from './model';

export function SyncConflictPanel({ item, busy, resolve, pause }: {
  item: SyncItem; busy: boolean; resolve: (choice: 'local' | 'remote') => void; pause?: () => void;
}) {
  if (!item.conflict) return null;
  const labels: Record<string, string> = { status: '状态', rate: '我的评分', comment: 'Bangumi 短评' };
  return <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
    <p className="font-medium">同步冲突：{item.conflict.fields.map(field => labels[field] ?? field).join('、')}</p>
    <p className="break-words text-xs text-muted-foreground">{item.conflict.reason}</p>
    <p className="whitespace-pre-wrap break-words">本地 · {valueLabel(item.conflict.local)}</p>
    <p className="whitespace-pre-wrap break-words">Bangumi · {valueLabel(item.conflict.remote)}</p>
    <p className="text-xs text-muted-foreground">选择后立即尝试同步。保留本地会上传所选字段，其中「未游玩」按「想玩」上传；采用 Bangumi 会更新本地记录。若采用远端删除收藏，会同时暂停本款同步。</p>
    <div className="flex flex-wrap gap-2">
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => resolve('local')}>保留本地</Button>
      <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => resolve('remote')}>采用 Bangumi</Button>
      {pause && <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={pause}>暂停本款同步</Button>}
    </div>
  </div>;
}
