import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDefaultSource } from '../src/features/metadata/preferences.ts';

test('missing, empty and invalid default source settings use VNDB', () => {
  for (const value of [null, undefined, '', '  ', 'unknown']) assert.equal(normalizeDefaultSource(value), 'vndb');
});
test('all supported sources survive stored-setting reload and normalization', () => {
  for (const [value, expected] of [['vndb','vndb'],['bangumi','bangumi'],['nextmoe','nextmoe'],['2dfan','2dfan'],[' VNDB ','vndb'],[' 2DFAN ','2dfan']]) {
    assert.equal(normalizeDefaultSource(value), expected);
  }
});
