import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as model from '../src/features/birthdays/model.ts';

process.env.TZ = 'Asia/Shanghai';
const date = (year, month, day) => new Date(year, month - 1, day, 12);
const character = (id, month, day, extra = {}) => ({
  id, source: 'vndb', externalId: id, name: id, originalName: null,
  birthdayMonth: month, birthdayDay: day, birthdayRaw: null, avatarPath: null,
  hidden: false, customized: false,
  games: [{ id: 1, title: '作品', favorite: 0, status: 'unplayed' }], ...extra,
});

test('birthday reminder defaults on and validates stored preferences without treating strings as booleans', () => {
  assert.equal(typeof model.parseBirthdayReminderPreferences, 'function');
  const parse = model.parseBirthdayReminderPreferences;
  for (const value of [null, '', '{', 'null', '[]', 'true']) {
    assert.deepEqual(parse(value), { enabled: true, lastShownDate: null });
  }
  assert.deepEqual(parse('{"enabled":false,"lastShownDate":"2026-10-21"}'), { enabled: false, lastShownDate: '2026-10-21' });
  assert.deepEqual(parse('{"enabled":"false","lastShownDate":"2026-02-30"}'), { enabled: true, lastShownDate: null });
});

test('only today’s visible library characters appear together in one celebration', () => {
  assert.equal(typeof model.planBirthdayCelebration, 'function');
  const plan = model.planBirthdayCelebration({ enabled: true, lastShownDate: null }, [
    character('today-a', 10, 21), character('tomorrow', 10, 22), character('today-b', 10, 21),
    character('hidden', 10, 21, { hidden: true }), character('no-game', 10, 21, { games: [] }),
    character('unknown', null, null),
  ], date(2026, 10, 21));
  assert.equal(plan.date, '2026-10-21');
  assert.deepEqual(plan.entries.map(e => e.character.id), ['today-a', 'today-b']);
  assert.equal(model.planBirthdayCelebration({ enabled: false, lastShownDate: null }, [character('today', 10, 21)], date(2026, 10, 21)), null);
  assert.equal(model.planBirthdayCelebration({ enabled: true, lastShownDate: null }, [], date(2026, 10, 21)), null);
});

test('a shown date suppresses repeats and restart, but the next local date can celebrate again', () => {
  assert.equal(typeof model.planBirthdayCelebration, 'function');
  const saved = { enabled: true, lastShownDate: '2026-10-21' };
  const characters = [character('today', 10, 21), character('tomorrow', 10, 22)];
  assert.equal(model.planBirthdayCelebration(saved, characters, new Date('2026-10-21T15:59:59Z')), null);
  const next = model.planBirthdayCelebration(saved, characters, new Date('2026-10-21T16:00:01Z'));
  assert.equal(next.date, '2026-10-22');
  assert.deepEqual(next.entries.map(e => e.character.id), ['tomorrow']);
  assert.equal(model.planBirthdayCelebration(saved, characters, date(2027, 10, 21)).date, '2027-10-21');
});

test('February 29 celebrations follow the existing March 1 convention in non-leap years', () => {
  assert.equal(typeof model.planBirthdayCelebration, 'function');
  const plan = model.planBirthdayCelebration({ enabled: true, lastShownDate: null }, [character('leap', 2, 29)], date(2026, 3, 1));
  assert.equal(plan.entries[0].observed, true);
  assert.equal(plan.date, '2026-03-01');
});
