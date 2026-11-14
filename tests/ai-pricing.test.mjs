import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EMPTY_USAGE, addUsage, estimateCost, formatCost, formatTokens, loadPricing } from '../src/features/ai/pricing.ts';

test('usage totals from each response are accumulated', () => {
  let totals = addUsage(EMPTY_USAGE, { promptTokens: 35, completionTokens: 87, totalTokens: 122, cacheHitTokens: 11, cacheMissTokens: 24 });
  totals = addUsage(totals, { promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  assert.equal(totals.promptTokens, 45);
  assert.equal(totals.completionTokens, 92);
  assert.equal(totals.totalTokens, 137);
  assert.equal(totals.cacheHitTokens, 11);
  assert.equal(totals.cacheMissTokens, 34);
  assert.equal(totals.requests, 2);
});

test('cost is estimated from user supplied prices and hidden when empty', () => {
  const totals = addUsage(EMPTY_USAGE, { promptTokens: 1_000_000, completionTokens: 500_000, totalTokens: 1_500_000 });
  assert.equal(estimateCost(totals, { inputPerMillion: 0, outputPerMillion: 0 }), undefined);
  const cost = estimateCost(totals, { inputPerMillion: 1, outputPerMillion: 4 });
  assert.equal(cost.cny, 3);
  assert.equal(formatCost(cost.cny), '¥3.00');
  assert.equal(formatCost(0.00005), '<¥0.0001');
  assert.equal(formatTokens(1500000), '1,500,000');
});

test('pricing defaults to empty when no settings have been saved', () => {
  assert.deepEqual(loadPricing(), { inputPerMillion: 0, outputPerMillion: 0 });
});
