import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCoverPreferences, effectiveCoverPath } from '../src/features/covers/model.ts';

test('custom cover survives reload and takes precedence over a refreshed source cover', () => {
  const prefs = parseCoverPreferences('{"customPath":"E:/cache/custom.png","censored":true}');
  assert.equal(effectiveCoverPath('E:/new-source.jpg', prefs), 'E:/cache/custom.png');
  assert.equal(prefs.censored, true);
});

test('restoring source cover keeps censorship enabled', () => {
  const prefs = parseCoverPreferences('{"customPath":null,"censored":true}');
  assert.equal(effectiveCoverPath('E:/source.jpg', prefs), 'E:/source.jpg');
  assert.equal(prefs.censored, true);
});

test('invalid stored preferences do not break cover rendering or enable a truthy string', () => {
  for (const value of [null, '', '{', 'null', '[]', '42']) {
    assert.deepEqual(parseCoverPreferences(value), { customPath: null, censored: false });
  }
  assert.deepEqual(parseCoverPreferences('{"customPath":123,"censored":"false"}'), { customPath: null, censored: false });
  assert.equal(effectiveCoverPath(null, parseCoverPreferences(null)), null);
});
