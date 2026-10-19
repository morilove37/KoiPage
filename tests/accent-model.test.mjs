import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAccentHex,
  parseAccentSettings,
  accentColor,
  accentTokens,
} from '../src/lib/accent-model.ts';

test('custom colors accept short and full hex and reject unsupported CSS values', () => {
  assert.equal(normalizeAccentHex(' #aBc '), '#AABBCC');
  assert.equal(normalizeAccentHex('12abEF'), '#12ABEF');
  for (const value of ['', '#12', '#12345g', '#12345678', 'red', 'hsl(0 0% 0%)', null, 42]) {
    assert.equal(normalizeAccentHex(value), null);
  }
});

test('saved custom choice roundtrips while invalid storage falls back safely', () => {
  const expected = { preset: 'custom', customHex: '#AABBCC' };
  assert.deepEqual(parseAccentSettings(JSON.stringify({ preset: 'custom', customHex: '#abc' })), expected);
  assert.deepEqual(parseAccentSettings(JSON.stringify(expected)), expected);
  for (const value of [null, '', '{', 'null', '[]', '42', '{"preset":"missing","customHex":"oops"}']) {
    assert.deepEqual(parseAccentSettings(value), { preset: 'purple', customHex: '#7C3AED' });
  }
  assert.deepEqual(parseAccentSettings('{"preset":"custom","customHex":"oops"}'), { preset: 'purple', customHex: '#7C3AED' });
  assert.deepEqual(parseAccentSettings('{"preset":"blue","customHex":"#abc"}'), { preset: 'blue', customHex: '#AABBCC' });
});

test('preset selection uses its color without discarding the saved custom color', () => {
  const saved = parseAccentSettings('{"preset":"blue","customHex":"#F0F000"}');
  assert.equal(accentColor(saved), '#2563EB');
  assert.equal(accentColor({ ...saved, preset: 'custom' }), '#F0F000');
});

// Independent WCAG luminance calculation catches incorrect foreground choice
// and missing contrast adjustment for black/white/custom pastel accents.
function luminance(hex) {
  const linear = hex.match(/[0-9a-f]{2}/gi).map(channel => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
function contrast(first, second) {
  const a = luminance(first), b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('custom accents preserve their chosen fill and provide readable text in every theme', () => {
  for (const [mode, background] of [['light', '#FFFFFF'], ['dark', '#0A0A0B'], ['glass', '#191427']]) {
    for (const hex of ['#FFFFFF', '#000000', '#FFFF00', '#AABBCC', '#2563EB', '#7C3AED']) {
      const tokens = accentTokens({ preset: 'custom', customHex: hex }, mode);
      assert.equal(tokens.hex, hex);
      assert.ok(contrast(hex, tokens.foregroundHex) >= 4.5, `${hex} button text in ${mode}`);
      assert.ok(contrast(background, tokens.textHex) >= 4.5, `${hex} accent text in ${mode}`);
    }
  }
  assert.equal(accentTokens({ preset: 'custom', customHex: '#FFFFFF' }, 'light').foregroundHex, '#000000');
  assert.equal(accentTokens({ preset: 'custom', customHex: '#000000' }, 'dark').foregroundHex, '#FFFFFF');
});
