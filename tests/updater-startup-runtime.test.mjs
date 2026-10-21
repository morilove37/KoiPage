import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync } from 'node:fs';

// Exercise the production startup lifecycle, mocking only native/network boundaries.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith('/updater.ts')) {
      const mocks = {
        '@tauri-apps/api/core': 'export const isTauri = () => true; export const invoke = async () => {};',
        '@tauri-apps/plugin-updater': 'export const check = () => globalThis.startupUpdateTest.check();',
        './db': 'export const settingsGet = async () => globalThis.startupUpdateTest.preference; export const settingsSet = async () => {};',
      };
      if (specifier in mocks) return { url: 'data:text/javascript,' + encodeURIComponent(mocks[specifier]), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith('/updater.ts')) {
      const source = readFileSync(new URL(url), 'utf8').replace('import.meta.env.DEV', 'false');
      return { format: 'module', source: stripTypeScriptTypes(source), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});
let timer;
globalThis.window = {
  setTimeout(callback) { timer = callback; return 1; },
  clearTimeout() { timer = null; },
};
const { useUpdateStore: store, scheduleStartupUpdateCheck } = await import('../src/lib/updater.ts');
const settle = () => new Promise(setImmediate);

test('startup remains pending through the delay and network check, then exposes the update dialog', async () => {
  let finish;
  globalThis.startupUpdateTest = { preference: '1', check: () => new Promise(resolve => { finish = resolve; }) };
  assert.equal(store.getState().startupPending, true);
  const cancel = scheduleStartupUpdateCheck();
  assert.equal(store.getState().startupPending, true);
  timer(); await settle();
  assert.equal(store.getState().status, 'checking');
  assert.equal(store.getState().dialogOpen, false);
  assert.equal(store.getState().startupPending, true);
  finish({ version: '9.0.0', body: 'update', close: async () => {} }); await settle();
  assert.equal(store.getState().startupPending, false);
  assert.equal(store.getState().dialogOpen, true);
  cancel();
});

test('cancelled timers do not check, and disabled or failing checks release startup priority', async () => {
  let checks = 0;
  globalThis.startupUpdateTest = { preference: '0', check: async () => { checks++; throw new Error('offline'); } };
  const cancel = scheduleStartupUpdateCheck(); cancel();
  assert.equal(timer, null);
  const disabled = scheduleStartupUpdateCheck(); timer(); await settle();
  assert.equal(store.getState().startupPending, false);
  assert.equal(checks, 0); disabled();
  globalThis.startupUpdateTest.preference = '1';
  const failed = scheduleStartupUpdateCheck(); timer(); await settle();
  assert.equal(checks, 1);
  assert.equal(store.getState().startupPending, false);
  assert.equal(store.getState().status, 'error'); failed();
});
