import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { networkProxyGet, networkProxySave, networkProxyTest, type ProxyConfig } from '@/lib/db';

const PLACEHOLDER = 'http://127.0.0.1:7890';

/**
 * Settings → 网络代理.
 *
 * 2DFan and Bangumi are unreachable from some networks; a proxy is the only way
 * to make the metadata panel work there. Saving applies immediately — the Rust
 * side keeps the resolved proxy in a process-wide cache, so the next request
 * uses it without a restart.
 */
export function ProxySettings() {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  // Probe result for the saved configuration, shown without the user pressing
  // anything: a proxy client that is not running is the most likely reason the
  // metadata panel looks broken, and silence would hide it.
  const [probe, setProbe] = useState<'idle' | 'checking' | 'ok' | 'fail'>('idle');
  const [probeNote, setProbeNote] = useState<string | null>(null);
  // Guards against a slow save overwriting a newer one.
  const request = useRef(0);

  useEffect(() => {
    let alive = true;
    void networkProxyGet()
      .then(config => {
        if (!alive) return;
        setEnabled(config.enabled);
        setUrl(config.url);
        setLoaded(true);
        if (!config.enabled || !config.url.trim()) { setProbe('idle'); return; }
        setProbe('checking');
        void networkProxyTest({ enabled: true, url: config.url })
          .then(note => { if (!alive) return; setProbe('ok'); setProbeNote(note); })
          .catch(cause => { if (!alive) return; setProbe('fail'); setProbeNote(String(cause)); });
      })
      .catch(cause => {
        if (!alive) return;
        setError(String(cause));
        setLoaded(true);
      });
    return () => { alive = false; };
  }, []);

  async function save(next: ProxyConfig) {
    const version = ++request.current;
    setSaving(true);
    setError(null);
    setResult(null);
    try {
      const stored = await networkProxySave(next);
      if (version !== request.current) return;
      setEnabled(stored.enabled);
      setUrl(stored.url);
      if (stored.enabled && stored.url.trim()) {
        setProbe('checking');
        void networkProxyTest({ enabled: true, url: stored.url })
          .then(note => { if (version === request.current) { setProbe('ok'); setProbeNote(note); } })
          .catch(cause => { if (version === request.current) { setProbe('fail'); setProbeNote(String(cause)); } });
      } else {
        setProbe('idle');
        setProbeNote(null);
      }
    } catch (cause) {
      if (version === request.current) setError(String(cause));
    } finally {
      if (version === request.current) setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setError(null);
    setResult(null);
    try {
      setResult(await networkProxyTest({ enabled: true, url }));
    } catch (cause) {
      setError(String(cause));
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p id="proxy-label" className="text-sm font-medium">使用代理连接外网</p>
          <p className="mt-1 text-xs text-muted-foreground">
            资料匹配、AI 助手与分享上传都会走这个代理。2DFan 在部分网络下无法直连，开启后可以正常搜索攻略。
          </p>
        </div>
        <button
          type="button" role="switch" aria-checked={enabled} aria-labelledby="proxy-label"
          disabled={!loaded || saving} onClick={() => void save({ enabled: !enabled, url })}
          className={cn('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', enabled ? 'bg-primary' : 'bg-muted-foreground/40')}
        >
          <span className={cn('inline-block h-4 w-4 rounded-full bg-white transition-transform', enabled ? 'translate-x-6' : 'translate-x-1')} />
        </button>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-xs text-muted-foreground">
          代理地址
          <Input
            aria-label="代理地址"
            value={url}
            disabled={!loaded || saving}
            spellCheck={false}
            onChange={event => { setUrl(event.target.value); setError(null); setResult(null); }}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void save({ enabled: true, url }); } }}
            placeholder={PLACEHOLDER}
            className="font-mono"
          />
        </label>
        <Button type="button" variant="outline" disabled={!loaded || saving || !url.trim()} onClick={() => void save({ enabled: true, url })}>
          {saving ? '保存中…' : '保存'}
        </Button>
        <Button type="button" variant="ghost" disabled={!loaded || testing || !url.trim()} onClick={() => void test()}>
          {testing ? '测试中…' : '测试连接'}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        支持 http、https、socks4、socks5（socks5h 会在代理解析 DNS，适合 DNS 被污染的线路）。地址可省略协议，默认按 http 处理。
      </p>
      {probe === 'checking' ? <p className="text-xs text-muted-foreground">正在检查代理是否可用…</p> : null}
      {probe === 'ok' && probeNote ? <p className="text-xs text-emerald-500">代理可用 — {probeNote}</p> : null}
      {probe === 'fail' ? (
        <p role="status" className="text-xs text-amber-500">
          代理当前连不上{probeNote ? `（${probeNote}）` : ''}。如果代理软件没有打开或没在监听这个端口，请先启动它，或关闭上面的开关改用直连。
        </p>
      ) : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {result ? <p className="text-xs text-emerald-500">{result}</p> : null}
    </div>
  );
}
