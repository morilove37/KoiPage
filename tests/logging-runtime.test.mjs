import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/logging.ts')) {
      if (specifier === '@tauri-apps/api/core') return { url: 'data:text/javascript,export const invoke = (...args) => globalThis.logTestInvoke(...args);', shortCircuit: true };
      if (specifier === './log-model') return nextResolve('./log-model.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
const { recordLog, flushLogs } = await import('../src/lib/logging.ts');

test('explicit flush waits for pending writes and drains every queued batch before export', async () => {
  const batches = [];
  let release;
  globalThis.logTestInvoke = async (command, { entries }) => {
    assert.equal(command, 'logs_write');
    batches.push(entries);
    if (batches.length === 1) await new Promise(resolve => { release = resolve; });
  };
  recordLog('INFO', 'test', 'first');
  const background = flushLogs();
  for (let i = 0; i < 65; i++) recordLog('INFO', 'test', `queued-${i}`);
  let done = false;
  const beforeExport = flushLogs().then(() => { done = true; });
  await new Promise(setImmediate);
  assert.equal(done, false, 'export must wait for the in-flight write');
  release();
  await Promise.all([background, beforeExport]);
  assert.equal(batches.flat().length, 66);
  assert.ok(batches.every(batch => batch.length <= 50));
  delete globalThis.logTestInvoke;
});
