import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { buildPlayTimeSummary, playTimeWindow } from "../src/features/home/play-time.ts";

process.env.TZ = "Asia/Shanghai";
const date = (month, day, hour = 0, minute = 0) => new Date(2026, month - 1, day, hour, minute);
const now = date(10, 17, 12);
const session = (id, start, end, durationSeconds) => ({ id, gameId: 1, startedAt: start.toISOString(), endedAt: end?.toISOString() ?? null, durationSeconds });

test("calendar ranges use local midnight, Monday and the calendar month", () => {
  const result = buildPlayTimeSummary([], now);
  assert.equal(result.day.buckets.length, 24);
  assert.equal(result.week.buckets.length, 7);
  assert.equal(result.month.buckets.length, 31);
  assert.equal(result.week.buckets[0].start, date(10, 12).getTime());
  assert.equal(result.month.buckets[0].start, date(10, 1).getTime());
  assert.deepEqual(playTimeWindow(date(11, 1, 12)), { start: date(10, 26).toISOString(), end: date(11, 2).toISOString() });
});

test("cross-midnight sessions split between hours and days without losing duration", () => {
  const result = buildPlayTimeSummary([session(1, date(10, 16, 23, 30), date(10, 17, 1, 30), 7200)], now);
  assert.equal(result.day.totalSeconds, 5400);
  assert.equal(result.day.buckets[0].seconds, 3600);
  assert.equal(result.day.buckets[1].seconds, 1800);
  assert.equal(result.week.totalSeconds, 7200);
  assert.equal(result.month.totalSeconds, 7200);
});

test("week and month boundaries count only time inside the selected calendar period", () => {
  const result = buildPlayTimeSummary([
    session(1, date(10, 11, 23), date(10, 12, 1), 7200),
    session(2, date(9, 30, 23), date(10, 1, 1), 7200),
  ], now);
  assert.equal(result.day.totalSeconds, 0);
  assert.equal(result.week.totalSeconds, 3600);
  assert.equal(result.month.totalSeconds, 10800);
});

test("recorded duration is authoritative and is apportioned over a spanning session", () => {
  const result = buildPlayTimeSummary([session(1, date(10, 16, 23), date(10, 17, 1), 1800)], now);
  assert.equal(result.day.totalSeconds, 900);
  assert.equal(result.week.totalSeconds, 1800);
});

test("unfinished, invalid and future records do not inflate recorded playtime", () => {
  const valid = session(1, date(10, 17, 8), date(10, 17, 9), 3600);
  const result = buildPlayTimeSummary([
    valid, session(2, date(10, 17, 10), null, 0),
    {...valid, id:3, startedAt:"broken"}, {...valid, id:4, durationSeconds:NaN},
    {...valid, id:5, durationSeconds:-1}, session(6, date(10, 17, 9), date(10, 17, 8), 3600),
    session(7, date(10, 18, 8), date(10, 18, 9), 3600),
  ], now);
  assert.equal(result.day.totalSeconds, 3600);
  assert.equal(result.day.gameCount, 1);
});

test("all sessions contribute, including records beyond the recent-history limit", () => {
  const sessions = Array.from({length:1005}, (_, id) => ({...session(id, date(10, 17, 8), date(10, 17, 8, 1), 60), gameId:id%3}));
  const result = buildPlayTimeSummary(sessions, now);
  assert.equal(result.day.totalSeconds, 60300);
  assert.equal(result.day.gameCount, 3);
  assert.equal(result.week.activeDays, 1);
});

test("local calendar buckets survive daylight-saving days with 23 or 25 hours", () => {
  const moduleUrl = new URL("../src/features/home/play-time.ts", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
    import {buildPlayTimeSummary} from ${JSON.stringify(moduleUrl)};
    const counts=[new Date(2026,2,8,12),new Date(2026,10,1,12)].map(now=>buildPlayTimeSummary([],now).day.buckets.length);
    console.log(JSON.stringify(counts));
  `], {env:{...process.env,TZ:"America/New_York"},encoding:"utf8"});
  assert.deepEqual(JSON.parse(output), [23,25]);
});
