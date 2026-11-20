import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeCards, readHiddenHomeCards } from '../src/features/home/card-preferences.ts';

test('new and invalid preferences show the original cards', () => {
  for (const value of [null, 'invalid json', '{}', '[1,null]']) assert.deepEqual(readHiddenHomeCards(value), []);
});

test('hidden cards round-trip and unknown or duplicate keys are ignored', () => {
  assert.deepEqual(readHiddenHomeCards(JSON.stringify(['friends', 'bogus', 'friends', 'statistics'])), ['statistics', 'friends']);
  const allHidden = homeCards.map(card => card.id);
  assert.deepEqual(readHiddenHomeCards(JSON.stringify(allHidden)), allHidden);
});
