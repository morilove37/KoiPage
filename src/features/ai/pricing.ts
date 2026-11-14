/** Token 用量统计与按用户填写价格估算的费用；不绑定任何特定服务商。 */

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  requests: number;
}

export const EMPTY_USAGE: UsageTotals = {
  promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, requests: 0,
};

export function addUsage(totals: UsageTotals, usage: TokenUsage): UsageTotals {
  const hit = usage.cacheHitTokens ?? 0;
  return {
    promptTokens: totals.promptTokens + usage.promptTokens,
    completionTokens: totals.completionTokens + usage.completionTokens,
    totalTokens: totals.totalTokens + usage.totalTokens,
    cacheHitTokens: totals.cacheHitTokens + hit,
    cacheMissTokens: totals.cacheMissTokens + (usage.cacheMissTokens ?? Math.max(0, usage.promptTokens - hit)),
    requests: totals.requests + 1,
  };
}

/** 价格按「元 / 百万 tokens」填写；0 表示不换算价格。 */
export interface PriceConfig { inputPerMillion: number; outputPerMillion: number }

export const EMPTY_PRICE: PriceConfig = { inputPerMillion: 0, outputPerMillion: 0 };
const PRICING_KEY = 'koipage.ai.pricing';

function priceValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function loadPricing(): PriceConfig {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return { ...EMPTY_PRICE };
    const raw = JSON.parse(window.localStorage.getItem(PRICING_KEY) ?? 'null') as Partial<PriceConfig> | null;
    return { inputPerMillion: priceValue(raw?.inputPerMillion), outputPerMillion: priceValue(raw?.outputPerMillion) };
  } catch { return { ...EMPTY_PRICE }; }
}

export function savePricing(value: PriceConfig): void {
  try { window.localStorage.setItem(PRICING_KEY, JSON.stringify({ inputPerMillion: priceValue(value.inputPerMillion), outputPerMillion: priceValue(value.outputPerMillion) })); } catch { /* 无痕模式下忽略 */ }
}

/** 按输入/输出两个单价估算费用；两个单价都未填写时返回 undefined，只显示 token。 */
export function estimateCost(totals: UsageTotals, price: PriceConfig): { cny: number } | undefined {
  if (!(price.inputPerMillion > 0) && !(price.outputPerMillion > 0)) return undefined;
  const cny = (totals.promptTokens * price.inputPerMillion + totals.completionTokens * price.outputPerMillion) / 1_000_000;
  return { cny };
}

export function formatTokens(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('zh-CN');
}

export function formatCost(cny: number): string {
  if (cny <= 0) return '¥0';
  if (cny >= 0.01) return `¥${cny.toFixed(2)}`;
  if (cny >= 0.0001) return `¥${cny.toFixed(4)}`;
  return '<¥0.0001';
}
