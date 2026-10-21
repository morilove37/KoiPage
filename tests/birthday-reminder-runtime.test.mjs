import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

const db = `
  export const settingsGet = key => globalThis.birthdayReminderDatabase.get(key);
  export const settingsSet = (key, value) => globalThis.birthdayReminderDatabase.set(key, value);
`;
registerHooks({ resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/reminder-store.ts')) {
    if (specifier === '@/lib/db') return { url: 'data:text/javascript,' + encodeURIComponent(db), shortCircuit: true };
    if (specifier === './model') return nextResolve('./model.ts', context);
  }
  return nextResolve(specifier, context);
} });
const {
  BIRTHDAY_REMINDER_SETTING, useBirthdayReminderStore: store, initializeBirthdayReminder,
  showBirthdayCelebration, dismissBirthdayCelebration, setBirthdayReminderEnabled, retryBirthdayReminderSave,
} = await import('../src/features/birthdays/reminder-store.ts');

process.env.TZ = 'Asia/Shanghai';
const now = new Date(2026, 9, 21, 12);
const characters = [{ id: 'c1', source: 'vndb', externalId: 'c1', name: '角色', hidden: false,
  birthdayMonth: 10, birthdayDay: 21, games: [{ id: 1, title: '作品', favorite: 0, status: 'unplayed' }] }];
const settle = async () => {
  const deadline = Date.now() + 2000;
  while (store.getState().saving) {
    if (Date.now() > deadline) throw new Error('Reminder writes did not settle');
    await new Promise(setImmediate);
  }
};
let values, reads, writes, hold, release, failRead, failWrite;
beforeEach(async () => {
  await settle();
  values = new Map(); reads = 0; writes = []; hold = false; release = null; failRead = false; failWrite = false;
  store.setState({ preferences: null, activeDate: null, loading: true, saving: false, error: null });
  globalThis.birthdayReminderDatabase = {
    async get(key) { reads++; if (failRead) throw new Error('read unavailable'); return values.get(key) ?? null; },
    async set(key, value) {
      writes.push(JSON.parse(value));
      if (hold) { hold = false; await new Promise(resolve => { release = resolve; }); }
      if (failWrite) { failWrite = false; throw new Error('write unavailable'); }
      values.set(key, value);
    },
  };
});

test('one day is claimed immediately and persisted before dismissal, including a restart', async () => {
  await Promise.all([initializeBirthdayReminder(), initializeBirthdayReminder()]);
  assert.equal(reads, 1);
  hold = true;
  assert.equal(showBirthdayCelebration(characters, now), true);
  assert.equal(showBirthdayCelebration(characters, now), false);
  assert.equal(store.getState().activeDate, null, 'Do not present until the daily record has committed');
  await new Promise(setImmediate);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].lastShownDate, '2026-10-21');
  release(); await settle();
  assert.equal(store.getState().activeDate, '2026-10-21');
  dismissBirthdayCelebration();
  assert.equal(showBirthdayCelebration(characters, now), false);
  // A process restart loses all in-memory dismissal state but retains SQLite preferences.
  store.setState({ preferences: null, activeDate: null, loading: true });
  await initializeBirthdayReminder();
  assert.equal(showBirthdayCelebration(characters, now), false);
  assert.equal(showBirthdayCelebration([{ ...characters[0], birthdayDay: 22 }], new Date(2026, 9, 22, 12)), true);
  await settle();
});

test('disabling while the shown-date write is pending preserves both the date and latest toggle', async () => {
  await initializeBirthdayReminder(); hold = true;
  showBirthdayCelebration(characters, now);
  await new Promise(setImmediate);
  const disabled = setBirthdayReminderEnabled(false);
  await new Promise(setImmediate);
  assert.equal(store.getState().preferences.enabled, false);
  assert.equal(store.getState().activeDate, null);
  assert.equal(writes.length, 1);
  release(); await disabled; await settle();
  assert.deepEqual(JSON.parse(values.get(BIRTHDAY_REMINDER_SETTING)), { enabled: false, lastShownDate: '2026-10-21' });
  store.setState({ preferences: null, loading: true });
  await initializeBirthdayReminder();
  assert.equal(showBirthdayCelebration(characters, now), false);
  await setBirthdayReminderEnabled(true);
  assert.equal(showBirthdayCelebration(characters, now), false, 'Re-enabling must not repeat a day already celebrated');
});

test('read failures do not assume consent, and failed writes can be retried without repeating a popup', async () => {
  failRead = true;
  await initializeBirthdayReminder();
  assert.equal(store.getState().preferences, null);
  assert.equal(showBirthdayCelebration(characters, now), false);
  assert.match(store.getState().error, /读取失败/);
  failRead = false;
  await retryBirthdayReminderSave();
  failWrite = true;
  assert.equal(showBirthdayCelebration(characters, now), true);
  await settle();
  assert.match(store.getState().error, /保存失败/);
  assert.equal(store.getState().activeDate, null, 'A failed daily record must never present an unpersisted reminder');
  assert.equal(showBirthdayCelebration(characters, now), false);
  await retryBirthdayReminderSave();
  assert.equal(store.getState().error, null);
  assert.equal(store.getState().activeDate, '2026-10-21', 'A successful retry must present the still-pending greeting');
  assert.equal(JSON.parse(values.get(BIRTHDAY_REMINDER_SETTING)).lastShownDate, '2026-10-21');
  await setBirthdayReminderEnabled(false);
  assert.equal(store.getState().preferences.enabled, false);
});
