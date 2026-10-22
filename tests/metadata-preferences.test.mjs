import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDefaultSource, normalizeEnabledSources } from '../src/features/metadata/preferences.ts';

test('enabled sources default only when missing and preserve a valid subset', () => {
  assert.deepEqual(normalizeEnabledSources(null), ['nextmoe', 'vndb', 'bangumi', '2dfan']);
  assert.deepEqual(normalizeEnabledSources('["2dfan","vndb","vndb","unknown"]'), ['2dfan', 'vndb']);
  for (const value of ['', 'invalid', '[]', '{}', '["unknown"]']) assert.deepEqual(normalizeEnabledSources(value), []);
});

test('a disabled default falls back to the first enabled source', () => {
  assert.equal(normalizeDefaultSource('vndb', ['bangumi', '2dfan']), 'bangumi');
  assert.equal(normalizeDefaultSource('2dfan', ['bangumi', '2dfan']), '2dfan');
});

test('missing, empty and invalid default source settings use VNDB', () => {
  for (const value of [null, undefined, '', '  ', 'unknown']) assert.equal(normalizeDefaultSource(value), 'vndb');
});
test('all supported sources survive stored-setting reload and normalization', () => {
  for (const [value, expected] of [['vndb','vndb'],['bangumi','bangumi'],['nextmoe','nextmoe'],['2dfan','2dfan'],[' VNDB ','vndb'],[' 2DFAN ','2dfan']]) {
    assert.equal(normalizeDefaultSource(value), expected);
  }
});
