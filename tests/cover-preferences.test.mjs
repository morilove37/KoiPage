import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/features/covers/model.ts';
const { parseCoverPreferences, effectiveCoverPath } = model;

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
    assert.deepEqual(parseCoverPreferences(value), { customPath: null, censored: false, crop: null });
  }
  assert.deepEqual(parseCoverPreferences('{"customPath":123,"censored":"false"}'), { customPath: null, censored: false, crop: null });
  assert.equal(effectiveCoverPath(null, parseCoverPreferences(null)), null);
});

test('crop survives reload, clamps its bounds and only applies to its source image', () => {
  const prefs = parseCoverPreferences(JSON.stringify({ crop: { path: 'a.jpg', x: -0.1, y: 0.8, width: 0.4, height: 0.4 } }));
  assert.deepEqual(prefs.crop, { path: 'a.jpg', x: 0, y: 0.6, width: 0.4, height: 0.4 });
  assert.deepEqual(model.effectiveCoverCrop('a.jpg', prefs), prefs.crop);
  assert.equal(model.effectiveCoverCrop('b.jpg', prefs), null);
  for (const crop of [{ path: 'a', x: 0, y: 0, width: 0, height: 0.2 }, { path: 'a', x: '0', y: 0, width: 1, height: 1 }, { x: 0, y: 0, width: 1, height: 1 }]) {
    assert.equal(parseCoverPreferences(JSON.stringify({ crop })).crop, null);
  }
});

test('changing a custom image clears the crop while censorship changes retain it', () => {
  const prefs = parseCoverPreferences(JSON.stringify({ customPath: 'custom.jpg', censored: true, crop: { path: 'custom.jpg', x: 0, y: 0, width: 0.3, height: 0.8 } }));
  assert.equal(model.mergeCoverPreferences(prefs, { customPath: null }).crop, null);
  assert.equal(model.mergeCoverPreferences(prefs, { customPath: 'other.jpg' }).crop, null);
  assert.deepEqual(model.mergeCoverPreferences(prefs, { censored: false }).crop, prefs.crop);
});

test('crop drag uses actual image dimensions and stays 3:4 in each drag direction', () => {
  // On a 1600x800 image, a 300x400 crop is 0.1875 x 0.5 normalized.
  assert.deepEqual(model.cropFromDrag({ x: 0.25, y: 0.25 }, { x: 0.4375, y: 0.75 }, { width: 1600, height: 800 }),
    { x: 0.25, y: 0.25, width: 0.1875, height: 0.5 });
  assert.deepEqual(model.cropFromDrag({ x: 0.4375, y: 0.75 }, { x: 0.25, y: 0.25 }, { width: 1600, height: 800 }),
    { x: 0.25, y: 0.25, width: 0.1875, height: 0.5 });
  const edge = model.cropFromDrag({ x: 0.9, y: 0.9 }, { x: 1, y: 1 }, { width: 800, height: 1600 });
  assert.ok(edge.x + edge.width <= 1 && edge.y + edge.height <= 1);
  assert.ok(Math.abs(edge.width * 800 / (edge.height * 1600) - 0.75) < 0.00001);
});

test('moving a crop clamps the whole frame without changing its size', () => {
  assert.deepEqual(model.moveCoverCrop({ x: 0.2, y: 0.1, width: 0.3, height: 0.4 }, 1, -1),
    { x: 0.7, y: 0, width: 0.3, height: 0.4 });
});
