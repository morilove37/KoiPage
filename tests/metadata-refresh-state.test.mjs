import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptRefreshState, isRefreshActive } from '../src/features/metadata/metadata-refresh-state.ts';

const state = { phase: 'running', runId: 10, total: 4, processed: 2, updated: 1, needsReview: 1, failed: 0, skipped: 0, currentTitle: '作品', backupPath: 'backup.koibak', error: null, outcomes: [] };
test('late status and prior runs cannot regress progress already received from events', () => {
  for (const patch of [{ runId: 9 }, { processed: 1 }, { phase: 'backingUp' }, { updated: 0 }, { needsReview: 0 }]) {
    assert.equal(acceptRefreshState(state, { ...state, ...patch }), state);
  }
  const next = { ...state, processed: 3, updated: 2 };
  assert.equal(acceptRefreshState(state, next), next);
});
test('terminal phase wins a late running response at equal progress; a new run resets counters', () => {
  for (const phase of ['completed', 'stopped', 'failed']) {
    const terminal = { ...state, phase };
    assert.equal(acceptRefreshState(terminal, state), terminal);
    assert.equal(isRefreshActive(terminal), false);
    const newer = { ...state, runId: 11, phase: 'backingUp', processed: 0, updated: 0, needsReview: 0 };
    assert.equal(acceptRefreshState(terminal, newer), newer);
  }
  assert.equal(isRefreshActive(state), true);
  assert.equal(acceptRefreshState(null, state), state);
});
test('outcome details are not dropped by a stale response', () => {
  const withDetails = { ...state, outcomes: [{ gameId: 1, title: '作品', status: 'needsReview', message: '多个候选' }] };
  assert.equal(acceptRefreshState(withDetails, state), withDetails);
});

test('manual resolution reduces pending counters and stays resolved after a late pre-resolution snapshot', () => {
  const pending = { ...state, revision: 7, phase: 'completed', outcomes: [
    { gameId: 1, title: '作品', status: 'needsReview', message: '需匹配 Bangumi' },
  ] };
  const resolved = { ...pending, revision: 8, needsReview: 0, outcomes: [
    { gameId: 1, title: '作品', status: 'updated', message: '已手动匹配' },
  ] };
  assert.equal(acceptRefreshState(pending, resolved), resolved);
  assert.equal(acceptRefreshState(resolved, pending), resolved);
  assert.equal(acceptRefreshState(null, resolved), resolved, 'page remount uses backend resolution');
});

test('a later manual match clears failed items without changing processed progress', () => {
  const pending = { ...state, revision: 12, failed: 1, outcomes: [
    { gameId: 2, title: '失败作品', status: 'failed', message: '网络错误' },
  ] };
  const resolved = { ...pending, revision: 13, failed: 0, updated: 2, outcomes: [
    { gameId: 2, title: '失败作品', status: 'updated', message: '已手动匹配' },
  ] };
  assert.equal(acceptRefreshState(pending, resolved), resolved);
  assert.equal(acceptRefreshState(resolved, pending), resolved);
});
