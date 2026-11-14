import { useEffect, useRef, useState } from 'react';
import { getConfig, saveConfig, testConfig, type AiConfig } from './api';
import { loadPricing, savePricing, type PriceConfig } from './pricing';

const input = 'mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring disabled:opacity-60';
const button = 'rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50';
export function AiSettings() {
  const [config, setConfig] = useState<AiConfig>({ baseUrl: '', model: '', hasKey: false });
  const [key, setKey] = useState(''); const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(''); const [error, setError] = useState('');
  const [pricing, setPricing] = useState<PriceConfig>(loadPricing);
  const control = useRef<AbortController | null>(null);
  function updatePrice(field: keyof PriceConfig, raw: string) {
    const parsed = raw.trim() === '' ? 0 : Number(raw);
    const next: PriceConfig = { ...pricing, [field]: Number.isFinite(parsed) && parsed > 0 ? parsed : 0 };
    setPricing(next); savePricing(next);
  }
  useEffect(() => {
    let alive = true;
    void getConfig().then(value => { if (alive) setConfig(value); }).catch(cause => { if (alive) setError(String(cause)); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; control.current?.abort(); };
  }, []);
  async function perform(kind: 'save' | 'test' | 'clear') {
    if (busy) return;
    setBusy(true); setNotice(''); setError('');
    const current = new AbortController(); control.current = current;
    try {
      if (kind === 'test') {
        const result = await testConfig(config, key, current.signal);
        if (!current.signal.aborted) setNotice(`${result.message}。测试使用当前填写内容；修改后请保存。`);
      } else {
        const value = await saveConfig(config, kind === 'clear' ? '' : key, kind === 'clear');
        if (!current.signal.aborted) { setConfig(value); setKey(''); setNotice(kind === 'clear' ? '已清除当前 API 地址保存的密钥。' : 'AI 设置已保存。可从左侧「AI 助手」开始使用。'); }
      }
    } catch (cause) { if (!current.signal.aborted) setError(String(cause)); }
    finally { if (!current.signal.aborted) setBusy(false); control.current = null; }
  }
  const disabled = busy || loading;
  return <div className="space-y-4">
    <p className="text-sm leading-relaxed text-muted-foreground">填写支持工具调用的兼容 Chat Completions 接口。AI 可查询游戏，修改标题、开发商、发售日期、评分和简介（包括翻译后直接替换），也可修改状态和收藏、添加标签、打开详情和启动游戏。资料修改按你的明确指令直接保存。</p>
    <fieldset disabled={disabled} className="grid gap-4">
      <label className="text-sm">API 地址<input className={input} autoComplete="off" spellCheck={false} placeholder="https://你的服务地址/v1" value={config.baseUrl} onChange={e => { setConfig({ ...config, baseUrl: e.target.value, hasKey: false }); setNotice(''); }} />
        <span className="mt-1 block text-xs text-muted-foreground">填写服务商提供的基础地址，通常以 /v1 结尾；也可填写完整 /chat/completions 地址。本机服务支持 HTTP。仅支持 OpenAI 兼容接口，Anthropic（/anthropic）等原生协议地址不适用。</span></label>
      <label className="text-sm">模型名称<input className={input} autoComplete="off" spellCheck={false} placeholder="填写服务商提供的模型 ID" value={config.model} onChange={e => { setConfig({ ...config, model: e.target.value }); setNotice(''); }} /></label>
      <label className="text-sm">API Key<input className={input} type="password" autoComplete="new-password" spellCheck={false} value={key} placeholder={config.hasKey ? '已安全保存，留空保留现有密钥' : '输入密钥；本机免密服务可留空'} onChange={e => setKey(e.target.value)} />
        <span className="mt-1 block text-xs text-muted-foreground">保存在此电脑的 Windows 凭据管理器中，不随游戏库备份导出。更换地址后请填写该服务的密钥。</span></label>
      <div className="rounded-md border border-border p-3">
        <p className="text-sm font-medium">费用估算（可选）</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">AI 面板会始终显示本次对话的 token 用量；按你所用服务商的价格（元/百万 tokens）填写后，会额外显示估算费用，留空只显示 token。不同服务商的缓存与计费规则不同，估算仅供参考。此设置立即保存在本机。</p>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-sm">输入价格（元/百万 tokens）<input className={input} type="number" min="0" step="0.01" placeholder="例如 1" value={pricing.inputPerMillion || ''} onChange={e => updatePrice('inputPerMillion', e.target.value)} /></label>
          <label className="text-sm">输出价格（元/百万 tokens）<input className={input} type="number" min="0" step="0.01" placeholder="例如 4" value={pricing.outputPerMillion || ''} onChange={e => updatePrice('outputPerMillion', e.target.value)} /></label>
        </div>
      </div>
    </fieldset>
    <div className="flex flex-wrap gap-2">
      <button className={`${button} bg-primary text-primary-foreground hover:bg-primary/90`} disabled={disabled} onClick={() => void perform('save')}>保存设置</button>
      <button className={button} disabled={disabled} onClick={() => void perform('test')}>{busy ? '处理中…' : '测试连接与工具调用'}</button>
      <button className={button} disabled={disabled || !config.hasKey} onClick={() => void perform('clear')}>清除已保存密钥</button>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">对话及完成任务所需的游戏资料会发送给你填写的服务，可能产生 API 费用。本地路径和私人笔记不发送。对话仅保留在本次软件运行期间；启动游戏需确认。</p>
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
