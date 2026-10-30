import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileDraft, profileInput, rebaseProfileDraft } from '../src/features/bangumi-sync/model.ts';
import { runExclusive, startSyncPolling } from '../src/features/bangumi-sync/runtime.ts';

const item = { revision: 4, gameId: 7, subjectId: 123, enabled: true, personalRate: null, personalComment: null };
test('saving a binding or toggle preserves absent personal fields; zero and empty comment are explicit edits', () => {
  const draft = profileDraft(item);
  assert.deepEqual(profileInput(item, { ...draft, enabled: false, enabledEdited: true }), { expectedRevision: 4, gameId: 7, subjectId: 123, enabled: false, personalRate: null, personalComment: null });
  assert.equal(profileInput(item, { ...draft, rateEdited: true, rate: '0' }).personalRate, 0);
  assert.equal(profileInput(item, { ...draft, commentEdited: true, comment: '' }).personalComment, '');
  const changed = { ...item, personalRate: 8, personalComment: 'downloaded' };
  assert.equal(profileInput(changed, draft).personalRate, 8, 'untouched personal fields use the latest backend snapshot');
  assert.equal(profileInput(changed, draft).personalComment, 'downloaded');
});
test('rejects invalid bindings and decimal or out-of-range personal scores', () => {
  const draft = profileDraft(item);
  for (const subjectId of ['-1', '0', '1.5', 'abc', '9007199254740992']) assert.throws(() => profileInput(item, { ...draft, subjectId, subjectEdited: true }));
  for (const rate of ['1.5', '-1', '11', 'NaN']) assert.throws(() => profileInput(item, { ...draft, rateEdited: true, rate }));
});
test('a refreshed revision keeps edited fields and rebases all untouched values for a safe retry', () => {
  const draft = { ...profileDraft(item), rate: '9', rateEdited: true };
  const latest = { ...item, revision: 5, subjectId: 456, enabled: false, personalRate: 6, personalComment: 'remote edit' };
  const rebased = rebaseProfileDraft(latest, draft);
  assert.equal(rebased.rate, '9');
  assert.equal(rebased.comment, 'remote edit');
  assert.equal(rebased.subjectId, '456');
  assert.equal(rebased.enabled, false);
  assert.deepEqual(profileInput(latest, rebased), { expectedRevision: 5, gameId: 7, subjectId: 456, enabled: false, personalRate: 9, personalComment: 'remote edit' });
});
test('polling shares in-flight work across StrictMode remounts and cleans up all triggers', async () => {
  const timers = new Map(); const listeners = new Map(); let id = 0; let calls = 0; let release;
  const host = {
    setInterval(fn, delay) { assert.equal(delay, 10_000); timers.set(++id, fn); return id; },
    clearInterval(key) { timers.delete(key); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    removeEventListener(name, fn) { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  const run = () => { calls++; return new Promise(resolve => { release = resolve; }); };
  const first = startSyncPolling(run, host); first();
  const second = startSyncPolling(run, host);
  await Promise.resolve();
  timers.values().next().value(); listeners.get('focus')(); listeners.get('online')();
  assert.equal(calls, 1);
  release(); await runExclusive(run);
  timers.values().next().value(); await Promise.resolve();
  assert.equal(calls, 2);
  release(); await runExclusive(run);
  second(); assert.equal(timers.size, 0); assert.equal(listeners.size, 0);
});
test('a failed sync releases the guard so a later poll can retry', async () => {
  await assert.rejects(runExclusive(async () => { throw new Error('offline'); }));
  let calls = 0;
  await runExclusive(async () => { calls++; });
  assert.equal(calls, 1);
});
