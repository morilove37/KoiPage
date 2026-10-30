import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImportQueue } from '../src/features/scan/import-queue.ts';

test('retry only failed rows and never imports successful rows twice', async () => {
  const queue = new ImportQueue(['a', 'b', 'c']);
  const attempts = [];
  await queue.run([0, 1, 2], async value => { attempts.push(value); if (value === 'b') throw Error('offline'); return { status: 'imported', message: 'ok' }; });
  assert.deepEqual(queue.indices('failed'), [1]);
  await queue.run([0, 1, 2], async value => { attempts.push(value); return { status: 'imported', message: 'ok' }; });
  assert.deepEqual(attempts, ['a', 'b', 'c', 'b']);
  assert.equal(queue.rows[1].message, 'ok');
});

test('stop preserves committed imports and resume does not run concurrently', async () => {
  const queue = new ImportQueue(['a', 'b']);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const importer = async () => { calls++; await gate; return { status: 'imported', message: '' }; };
  const first = queue.run([0, 1], importer);
  await queue.run([0, 1], importer);
  queue.stop(); release(); await first;
  assert.equal(calls, 1);
  assert.equal(queue.rows[0].status, 'imported');
  assert.deepEqual(queue.indices('pending'), [1]);
  await queue.run(queue.indices('pending'), async () => ({ status: 'review', message: '需确认' }));
  assert.equal(queue.rows[1].status, 'review');
  await queue.run([1], importer);
  assert.equal(calls, 1);
});

test('stopping before commit leaves an item pending for later resumption', async () => {
  const queue = new ImportQueue(['a']);
  await queue.run([0], async (_, context) => {
    context.update('searching'); queue.stop();
    if (context.stopped()) return { status: 'pending', message: '' };
    throw Error('unexpected commit');
  });
  assert.deepEqual(queue.indices('pending'), [0]);
});
