import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlassAppearance, applyGlassAppearance, DEFAULT_GLASS_APPEARANCE } from '../src/lib/glass-appearance.ts';

test('glass controls have readable defaults independently of a custom wallpaper', () => {
  assert.deepEqual(parseGlassAppearance(null, null), { opacity: 72, blur: 24 });
  assert.deepEqual(parseGlassAppearance('bad', ''), DEFAULT_GLASS_APPEARANCE);
});

test('persisted glass values are bounded, including fully opaque and no blur', () => {
  assert.deepEqual(parseGlassAppearance('100', '0'), { opacity: 100, blur: 0 });
  assert.deepEqual(parseGlassAppearance('-1', '900'), { opacity: 40, blur: 60 });
  assert.deepEqual(parseGlassAppearance('48', '36'), { opacity: 48, blur: 36 });
});

test('glass changes update actual pane variables immediately without changing wallpaper', () => {
  const values = new Map([['--lg-bg-opacity', '0.4']]);
  const root = { style: { setProperty: (key, value) => values.set(key, value) } };
  applyGlassAppearance({ opacity: 100, blur: 0 }, root);
  assert.equal(values.get('--lg-pane-alpha'), '1');
  assert.equal(values.get('--lg-pane-blur'), '0px');
  assert.equal(values.get('--lg-bg-opacity'), '0.4');
});
