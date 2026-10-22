import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSaveBackupConfig, snapshotReason, formatSnapshotSize } from '../src/features/save-backups/model.ts';

test('automatic saves stay opt-in for missing or malformed configuration', () => {
  for (const value of [null, undefined, {}, { beforeLaunch: 'true', afterExit: 1, keepAutomatic: '5' }]) {
    assert.deepEqual(normalizeSaveBackupConfig(value), { beforeLaunch: false, afterExit: false, keepAutomatic: 10 });
  }
});

test('automatic retention is bounded and non-integral or non-finite values use the default', () => {
  assert.equal(normalizeSaveBackupConfig({ keepAutomatic: 0 }).keepAutomatic, 1);
  assert.equal(normalizeSaveBackupConfig({ keepAutomatic: 99 }).keepAutomatic, 50);
  for (const value of [NaN, Infinity, 2.5]) assert.equal(normalizeSaveBackupConfig({ keepAutomatic: value }).keepAutomatic, 10);
  assert.deepEqual(normalizeSaveBackupConfig({ beforeLaunch: true, afterExit: true, keepAutomatic: 7 }), { beforeLaunch: true, afterExit: true, keepAutomatic: 7 });
});

test('restore safety snapshots are distinguishable and unknown reasons remain visible', () => {
  assert.equal(snapshotReason('beforeRestore'), '恢复前安全备份');
  assert.equal(snapshotReason('manual'), '手动备份');
  assert.equal(snapshotReason('new-trigger'), 'new-trigger');
});

test('file sizes handle empty saves, unit boundaries and invalid data', () => {
  assert.equal(formatSnapshotSize(0), '0 B');
  assert.equal(formatSnapshotSize(1023), '1023 B');
  assert.equal(formatSnapshotSize(1024), '1.0 KB');
  assert.equal(formatSnapshotSize(1024 ** 3), '1.0 GB');
  assert.equal(formatSnapshotSize(-1), '大小未知');
});
