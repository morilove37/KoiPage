import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from '@/components/ui/button';
import { createVerificationFlow, type VerificationSnapshot } from './verification-flow';

/** The website receives the credentials directly; this component sees no cookies. */
export function TwoDfanVerification({ disabled = false, onRetry }: {
  disabled?: boolean;
  onRetry?: () => Promise<void>;
}) {
  const [state, setState] = useState<VerificationSnapshot>({ phase: 'idle', opened: false, error: null });
  const [synced, setSynced] = useState(false);
  const flow = useMemo(() => createVerificationFlow({
    open: () => invoke<void>('twodfan_verification_open'),
    sync: () => invoke<void>('twodfan_verification_sync'),
    changed: setState,
  }), []);
  useEffect(() => () => flow.cancel(), [flow]);
  const busy = state.phase === 'opening' || state.phase === 'syncing';
  return <div className="space-y-2 rounded-xl border border-border bg-muted/20 p-3 text-xs">
    <p className="text-muted-foreground">2DFan 需要登录或访问验证时，可在恋页内打开站点完成。会话单独保存在本机，供 2DFan 资料请求使用。</p>
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" size="sm" variant="outline" disabled={disabled || busy}
        onClick={() => { setSynced(false); void flow.open(); }}>
        {state.phase === 'opening' ? '正在打开…' : '2DFan 登录 / 验证'}
      </Button>
      {state.opened ? <Button type="button" size="sm" variant="outline" disabled={disabled || busy}
        onClick={() => void flow.complete(async () => {
          setSynced(true);
          await onRetry?.();
        })}>
        {state.phase === 'syncing' ? '正在读取会话…' : onRetry ? '已完成，重试' : '已完成，保存会话'}
      </Button> : null}
    </div>
    {state.opened ? <p className="text-muted-foreground">在站点窗口完成后返回这里操作；关闭该窗口也会保留登录状态。{onRetry ? '确认完成后可重试资料请求。' : '之后搜索时会使用该会话。'}</p> : null}
    {synced && !state.error ? <p role="status" className="text-muted-foreground">已读取站点会话，是否通过验证以资料请求结果为准。如仍受限，可重新验证或使用其他数据源。</p> : null}
    {state.error ? <p role="alert" className="break-words text-destructive">{state.error}</p> : null}
  </div>;
}
