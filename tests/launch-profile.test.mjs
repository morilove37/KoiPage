import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLaunchProfile, effectiveFlag } from '../src/features/launch/profile-model.ts';

test('launch overrides preserve inherit and never treat arbitrary strings as enabled', () => {
  assert.equal(effectiveFlag('inherit', true), true);
  assert.equal(effectiveFlag('off', true), false);
  assert.equal(effectiveFlag('on', false), true);
  assert.deepEqual(normalizeLaunchProfile(null), { locale: 'inherit', magpie: 'inherit', luna: 'inherit', localeSource: 'inherit', localePath: '', scalingMode: '' });
  assert.equal(normalizeLaunchProfile({ locale: 'yes', magpie: true }).locale, 'inherit');
  assert.equal(normalizeLaunchProfile({ locale: 'off', luna: 'on', scalingMode: '2' }).luna, 'on');
});
