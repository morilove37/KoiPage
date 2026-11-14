import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backupSummary, canRestore } from '../src/features/backup/model.ts';

test('restore requires explicit confirmation and an idle validated preview', () => {
  assert.equal(canRestore(null, true, false), false);
  assert.equal(canRestore({ games: 2, assets: 4 }, false, false), false);
  assert.equal(canRestore({ games: 2, assets: 4 }, true, true), false);
  assert.equal(canRestore({ games: 2, assets: 4 }, true, false), true);
  assert.equal(backupSummary({ games: 2, sessions: 3, assets: 4 }), '2 款游戏 · 3 条游玩记录 · 4 张图片');
  assert.equal(backupSummary({ games: 2, sessions: 3, assets: 1, skippedImages: 2 }), '2 款游戏 · 3 条游玩记录 · 1 张图片 · 已跳过 2 张缺失图片');
});
