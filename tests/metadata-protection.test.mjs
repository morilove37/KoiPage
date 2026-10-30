import { test } from 'node:test';
import assert from 'node:assert/strict';
import { currentMetadataValues, protectExistingFields } from '../src/features/metadata/protection.ts';

test('refresh selects only missing fields and treats zero rating as populated', () => {
  const values = currentMetadataValues({ title: '手动标题', originalTitle: ' ', developer: null, rating: 0 }, ['手动标签']);
  assert.deepEqual(protectExistingFields({ title: true, original_title: true, developer: true, rating: true, tags: true }, values),
    { title: false, original_title: true, developer: true, rating: false, tags: false });
});

test('new imports retain available selections and missing upstream stays unchecked', () => {
  const available = { title: true, rating: false };
  assert.deepEqual(protectExistingFields(available, null), available);
  assert.deepEqual(protectExistingFields(available, { title: '' }), available);
});
