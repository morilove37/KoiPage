import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryRenderCount, LIBRARY_RENDER_BATCH } from '../src/features/library/render-window.ts';

test('large libraries initially mount one batch and can reveal every result', () => {
  const ids = Array.from({ length: 10000 }, (_, id) => id);
  assert.equal(libraryRenderCount(ids.length), LIBRARY_RENDER_BATCH);
  let count = libraryRenderCount(ids.length);
  while (count < ids.length) count = libraryRenderCount(ids.length, count + LIBRARY_RENDER_BATCH);
  assert.equal(count, ids.length);
  assert.equal(new Set(ids.slice(0, count)).size, ids.length);
});

test('restored counts keep scrollable results and shrink safely after filtering', () => {
  assert.equal(libraryRenderCount(10000, 600), 600);
  assert.equal(libraryRenderCount(23, 600), 23);
  assert.equal(libraryRenderCount(0, 120), 0);
  for (const invalid of [NaN, Infinity, -1]) assert.equal(libraryRenderCount(1000, invalid), LIBRARY_RENDER_BATCH);
});
