import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detailPatchFor, launchPathUnavailable } from '../src/features/detail/detail-edits.ts';

test('saving each detail section leaves the other drafts out of the write', () => {
  const patch = { title: '新标题', description: null, exePath: 'D:\\game.exe', savePath: null, tags: [], tagNames: ['新标签'] };
  assert.deepEqual(detailPatchFor(patch, 'info'), { title: '新标题', description: null });
  assert.deepEqual(detailPatchFor(patch, 'files'), { exePath: 'D:\\game.exe', savePath: null });
  assert.deepEqual(detailPatchFor(patch, 'tags'), { tags: [], tagNames: ['新标签'] });
});

test('missing launch paths route to setup without blocking a currently running game', () => {
  assert.equal(launchPathUnavailable(null, undefined, false), true);
  assert.equal(launchPathUnavailable('D:\\game.exe', 'missingExe', false), true);
  assert.equal(launchPathUnavailable('D:\\game.exe', 'offline', false), true);
  assert.equal(launchPathUnavailable('D:\\game.exe', 'missingFolder', false), true);
  assert.equal(launchPathUnavailable('D:\\game.exe', undefined, false), false);
  assert.equal(launchPathUnavailable(null, 'missingExe', true), false);
});
