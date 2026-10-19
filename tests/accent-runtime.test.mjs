import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

// Replace only Tauri's SQLite boundary; exercise the actual startup, theme,
// CSS-token and write-queue code without launching a desktop process.
const dbModule = `
  export async function settingsGet(key) { return globalThis.accentTestDatabase.get(key); }
  export async function settingsSet(key, value) { return globalThis.accentTestDatabase.set(key, value); }
`;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.match(/\/(accent|theme)\.ts$/)) {
      if (specifier === './db') return { url: `data:text/javascript,${encodeURIComponent(dbModule)}`, shortCircuit: true };
      if (specifier === './accent' || specifier === './accent-model') return nextResolve(`${specifier}.ts`, context);
    }
    return nextResolve(specifier, context);
  },
});

const { initTheme, applyTheme } = await import('../src/lib/theme.ts');
const { setAccent, initAccent } = await import('../src/lib/accent.ts');
const { ACCENT_SETTING_KEY, DEFAULT_ACCENT } = await import('../src/lib/accent-model.ts');

test('startup restores accent, theme changes retain it, and rapid saves persist the latest choice', async () => {
  const values = new Map([
    ['theme', 'dark'],
    [ACCENT_SETTING_KEY, JSON.stringify({ preset: 'custom', customHex: '#fff' })],
  ]);
  const writes = [];
  const releases = [];
  let holdWrites = false;
  let failWrite = false;
  globalThis.accentTestDatabase = {
    get: key => values.get(key) ?? null,
    async set(key, value) {
      writes.push({ key, value });
      if (holdWrites) await new Promise(resolve => releases.push(resolve));
      if (failWrite) { failWrite = false; throw new Error('disk unavailable'); }
      values.set(key, value);
    },
  };
  const properties = new Map();
  const classes = new Set();
  const attributes = new Set();
  globalThis.document = { documentElement: {
    classList: {
      contains: name => classes.has(name),
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      toggle: (name, enabled) => enabled ? classes.add(name) : classes.delete(name),
    },
    style: {
      setProperty: (name, value) => properties.set(name, value),
      removeProperty: name => properties.delete(name),
    },
    toggleAttribute: (name, enabled) => enabled ? attributes.add(name) : attributes.delete(name),
  } };
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };
  try {
    assert.equal(await initTheme(), 'dark');
    assert.ok(classes.has('dark'));
    assert.equal(properties.get('--primary'), '0 0% 100%');
    assert.equal(properties.get('--primary-foreground'), '0 0% 0%');
    const darkText = properties.get('--primary-text');
    applyTheme('light');
    assert.equal(properties.get('--primary'), '0 0% 100%');
    assert.notEqual(properties.get('--primary-text'), darkText);
    applyTheme('glass');
    assert.ok(classes.has('glass'));
    assert.equal(properties.get('--primary'), '0 0% 100%');

    holdWrites = true;
    const first = setAccent({ preset: 'blue', customHex: '#123456' });
    const last = setAccent({ preset: 'custom', customHex: '#abc' });
    // Immediate fill changes happen before either SQLite write completes.
    assert.equal(properties.get('--primary'), '210 25% 73.33%');
    await new Promise(setImmediate);
    assert.equal(writes.length, 1);
    releases.shift()();
    await first;
    await new Promise(setImmediate);
    assert.equal(writes.length, 2);
    releases.shift()();
    await last;
    assert.deepEqual(JSON.parse(values.get(ACCENT_SETTING_KEY)), { preset: 'custom', customHex: '#AABBCC' });

    holdWrites = false;
    failWrite = true;
    await assert.rejects(setAccent({ preset: 'green', customHex: '#AABBCC' }), /disk unavailable/);
    await setAccent({ ...DEFAULT_ACCENT });
    assert.deepEqual(JSON.parse(values.get(ACCENT_SETTING_KEY)), { preset: 'purple', customHex: '#7C3AED' });
    assert.equal(properties.has('--primary'), false);
    assert.equal(properties.has('--primary-foreground'), false);
    assert.equal(attributes.has('data-custom-accent'), false);

    values.set(ACCENT_SETTING_KEY, '{broken');
    await initAccent();
    assert.equal(properties.has('--primary'), false);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
    delete globalThis.accentTestDatabase;
  }
});
