import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerificationFlow } from '../src/features/metadata/verification-flow.ts';

test('opening the site does not retry; explicit completion synchronizes before retrying', async () => {
  const events = [];
  const flow = createVerificationFlow({
    open: async () => { events.push('opened'); },
    sync: async () => { events.push('synchronized'); },
    changed: () => {},
  });
  await flow.open();
  assert.equal(flow.snapshot().opened, true);
  assert.deepEqual(events, ['opened']);
  await flow.complete(async () => { events.push('retried'); });
  assert.deepEqual(events, ['opened', 'synchronized', 'retried']);
  assert.equal(flow.snapshot().phase, 'ready');
});

test('failed native session synchronization preserves the retry action for another attempt', async () => {
  let unavailable = true;
  let retries = 0;
  const flow = createVerificationFlow({
    open: async () => {},
    sync: async () => { if (unavailable) throw new Error('读取会话失败'); },
    changed: () => {},
  });
  await flow.open();
  await flow.complete(async () => { retries += 1; });
  assert.equal(retries, 0);
  assert.equal(flow.snapshot().phase, 'error');
  assert.equal(flow.snapshot().error, '读取会话失败');
  unavailable = false;
  await flow.complete(async () => { retries += 1; });
  assert.equal(retries, 1);
});

test('closing the hosting dialog during synchronization prevents a stale search retry', async () => {
  let finish;
  let retries = 0;
  const flow = createVerificationFlow({
    open: async () => {},
    sync: () => new Promise(resolve => { finish = resolve; }),
    changed: () => {},
  });
  await flow.open();
  const pending = flow.complete(async () => { retries += 1; });
  flow.cancel();
  finish();
  await pending;
  assert.equal(retries, 0);
});

test('double clicking completion cannot issue duplicate retries', async () => {
  let finish;
  let retries = 0;
  const flow = createVerificationFlow({
    open: async () => {},
    sync: () => new Promise(resolve => { finish = resolve; }),
    changed: () => {},
  });
  await flow.open();
  const first = flow.complete(async () => { retries += 1; });
  await flow.complete(async () => { retries += 1; });
  finish();
  await first;
  assert.equal(retries, 1);
});
