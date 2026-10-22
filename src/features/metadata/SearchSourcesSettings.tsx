import { useEffect, useState } from 'react';
import { settingsGet, settingsSet, type MetadataProvider } from '@/lib/db';
import { ALL_PROVIDERS, PROVIDER_LABELS, errorMessage } from './fields';
import { ENABLED_SOURCES_KEY, normalizeEnabledSources } from './preferences';

export function SearchSourcesSettings({ onChange }: { onChange?: (sources: MetadataProvider[]) => void }) {
  const [enabled, setEnabled] = useState<MetadataProvider[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void settingsGet(ENABLED_SOURCES_KEY).then(value => {
      if (!alive) return;
      const sources = normalizeEnabledSources(value);
      setEnabled(sources);
      setLoaded(true);
      onChange?.(sources);
    }).catch(cause => { if (alive) setError(errorMessage(cause)); });
    return () => { alive = false; };
    // The callback only reports persisted state; its identity must not reload it.
  }, []);

  async function toggle(provider: MetadataProvider, checked: boolean) {
    const next = ALL_PROVIDERS.filter(item => item === provider ? checked : enabled.includes(item));
    if (!next.length) { setError('请至少保留一个搜索数据源。'); return; }
    setSaving(true);
    setError(null);
    try {
      await settingsSet(ENABLED_SOURCES_KEY, JSON.stringify(next));
      setEnabled(next);
      onChange?.(next);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setSaving(false); }
  }

  return <fieldset className="mb-4 space-y-2" disabled={!loaded || saving}>
    <legend className="text-xs font-medium text-muted-foreground">启用的搜索数据源</legend>
    <div className="flex flex-wrap gap-x-5 gap-y-2">
      {ALL_PROVIDERS.map(provider => <label key={provider} className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-3.5 shrink-0 accent-primary" checked={enabled.includes(provider)} onChange={event => void toggle(provider, event.target.checked)} />
        {PROVIDER_LABELS[provider]}
      </label>)}
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">只向勾选的数据源发送搜索和资料请求，适用于手动搜索、自动补全和批量导入。至少保留一个，更改后即时保存。</p>
    {loaded && !enabled.length && <p role="alert" className="text-xs text-destructive">数据源设置无效，请勾选至少一个数据源以恢复搜索。</p>}
    {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
  </fieldset>;
}
