import { test } from 'node:test';
import assert from 'node:assert/strict';
import { birthdayOccurrence, buildBirthdayEntries, birthdayLabel } from '../src/features/birthdays/model.ts';

process.env.TZ = 'Asia/Shanghai';
const date = (year, month, day, hour = 12) => new Date(year, month - 1, day, hour);
const character = (id, month, day, extra = {}) => ({ id, source:'vndb', externalId:id, name:id, originalName:null, birthdayMonth:month, birthdayDay:day, birthdayRaw:null, avatarPath:null, hidden:false, customized:false, games:[{id:1,title:'作品',favorite:0,status:'unplayed'}], ...extra });

test('birthdays use local calendar date and cross year by calendar days', () => {
  assert.deepEqual(birthdayOccurrence(1, 1, date(2026, 12, 31)), {days:1, date:'2027-01-01', observed:false});
  assert.equal(birthdayOccurrence(10, 18, new Date('2026-10-17T16:01:00Z')).days, 0);
  assert.equal(birthdayOccurrence(10, 18, date(2026, 10, 18, 23)).days, 0);
  assert.equal(birthdayOccurrence(10, 17, date(2026, 10, 18)).days, 364);
});
test('leap birthdays are observed March 1 in ordinary years without changing source date', () => {
  assert.deepEqual(birthdayOccurrence(2, 29, date(2026, 3, 1)), {days:0, date:'2026-03-01', observed:true});
  assert.deepEqual(birthdayOccurrence(2, 29, date(2028, 2, 28)), {days:1, date:'2028-02-29', observed:false});
  assert.equal(birthdayOccurrence(2, 29, date(2027, 3, 2)).date, '2028-02-29');
});
test('unknown, partial and impossible dates never become a real birthday', () => {
  for(const [m,d] of [[null,null],[2,null],[0,1],[13,1],[2,30],[4,31],[1.5,2],[1,NaN]]) assert.equal(birthdayOccurrence(m,d,date(2026,1,1)),null);
});
test('visible birthdays sort by day, favorite work, playing work and stable name', () => {
  const entries = buildBirthdayEntries([
    character('later',10,20), character('normal',10,18),
    character('playing',10,18,{games:[{id:2,title:'在玩',favorite:0,status:'playing'}]}),
    character('favorite',10,18,{games:[{id:3,title:'收藏',favorite:1,status:'completed'}]}),
    character('hidden',10,18,{hidden:true}), character('unknown',null,null),
  ],date(2026,10,18));
  assert.deepEqual(entries.map(e=>e.character.id),['favorite','playing','normal','later']);
  assert.equal(birthdayLabel(entries[0]),'今天生日');
  assert.equal(birthdayLabel(entries[3]),'还有 2 天');
});

test('homepage only includes today and birthdays within the next 30 days', () => {
  const now = date(2026, 12, 20);
  const entries = buildBirthdayEntries([character('today',12,20),character('edge',1,19),character('later',1,20),character('past',12,19)],now);
  assert.deepEqual(entries.map(e=>e.character.id),['today','edge']);
});
