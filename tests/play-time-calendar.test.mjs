import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { calendarMonth, monthWindow } from "../src/features/home/play-time-calendar.ts";

process.env.TZ = "Asia/Shanghai";
const date = (year, month, day, hour = 0, minute = 0) => new Date(year, month - 1, day, hour, minute);
const now = date(2026, 10, 17, 12);
const session = (id, gameId, start, end, durationSeconds) => ({id,gameId,startedAt:start.toISOString(),endedAt:end?.toISOString()??null,durationSeconds});

test("past calendar months are complete and keep local month boundaries", () => {
  const month = date(2026, 9, 1);
  assert.deepEqual(monthWindow(month), { start:month.toISOString(), end:date(2026,10,1).toISOString() });
  const result = calendarMonth([], month, now);
  assert.equal(result.days.length, 30);
  assert.equal(result.leadingDays, 1); // Tuesday, Monday-first.
  assert.equal(result.days[0].key, "2026-09-01");
  assert.equal(result.days.at(-1).key, "2026-09-30");
});

test("leap years and year changes use actual calendar lengths", () => {
  assert.equal(calendarMonth([],date(2024,2,1),now).days.length,29);
  assert.equal(calendarMonth([],date(2025,2,1),now).days.length,28);
  assert.equal(monthWindow(date(2025,12,1)).end,date(2026,1,1).toISOString());
});

test("cross-month sessions split duration and group each day's games correctly", () => {
  const records = [
    session(1,66,date(2026,8,31,23),date(2026,9,1,1),7200),
    session(2,67,date(2026,9,1,12),date(2026,9,1,13),3600),
    session(3,66,date(2026,9,30,23),date(2026,10,1,1),7200),
  ];
  const result = calendarMonth(records,date(2026,9,1),now);
  assert.equal(result.totalSeconds,10800);
  assert.equal(result.days[0].seconds,7200);
  assert.deepEqual(result.days[0].games,[{gameId:66,seconds:3600},{gameId:67,seconds:3600}]);
  assert.equal(result.days[29].seconds,3600);
  assert.equal(result.activeDays,2);
  assert.equal(result.gameCount,2);
});

test("manual duration changes, invalid sessions and future days follow summary rules", () => {
  const records = [
    session(1,1,date(2026,10,16,23),date(2026,10,17,1),1800),
    session(2,1,date(2026,10,17,10),null,0),
    session(3,2,date(2026,10,18),date(2026,10,18,1),3600),
    {...session(4,1,date(2026,10,16),date(2026,10,16,1),3600),startedAt:"broken"},
  ];
  const result = calendarMonth(records,date(2026,10,1),now);
  assert.equal(result.totalSeconds,1800);
  assert.equal(result.days[15].seconds,900);
  assert.equal(result.days[16].seconds,900);
  assert.equal(result.days[17].seconds,0);
  assert.equal(result.days[17].future,true);
});

test("old records beyond the history page limit all contribute to a review", () => {
  const records=Array.from({length:1107},(_,id)=>session(id,id%2,date(2025,12,3,12),date(2025,12,3,12,1),60));
  const result=calendarMonth(records,date(2025,12,1),now);
  assert.equal(result.days[2].seconds,66420);
  assert.equal(result.totalSeconds,66420);
  assert.equal(result.gameCount,2);
});

test("daily calendar allocations respect daylight saving time", () => {
  const url=new URL("../src/features/home/play-time-calendar.ts",import.meta.url).href;
  const output=execFileSync(process.execPath,["--input-type=module","-e",`
    import {calendarMonth} from ${JSON.stringify(url)};
    const start=new Date(2026,2,8),end=new Date(2026,2,9);
    const records=[{id:1,gameId:1,startedAt:start.toISOString(),endedAt:end.toISOString(),durationSeconds:(+end-+start)/1000}];
    console.log(calendarMonth(records,new Date(2026,2,1),new Date(2026,3,1)).days[7].seconds);
  `],{env:{...process.env,TZ:"America/New_York"},encoding:"utf8"});
  assert.equal(Number(output),23*3600);
});
