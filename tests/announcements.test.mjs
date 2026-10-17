import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePreferences, planStartup, setDismissed } from "../src/features/announcements/model.ts";

test("first launch shows welcome without treating a new installation as an upgrade", () => {
  const plan = planStartup(parsePreferences(null), "0.3.1");
  assert.deepEqual(plan.queue, ["welcome"]);
  assert.equal(plan.preferences.lastVersion, "0.3.1");
  assert.equal(plan.preferences.updateNoticeVersion, null);
});

test("closing without suppression shows the welcome on next launch", () => {
  const first = planStartup(parsePreferences(null), "0.3.1");
  const next = setDismissed(first.preferences, "welcome", "0.3.1", false);
  assert.deepEqual(planStartup(next, "0.3.1").queue, ["welcome"]);
});

test("welcome suppression survives upgrades while version suppression expires on the next update", () => {
  let preferences = planStartup(parsePreferences(null), "0.3.1").preferences;
  preferences = setDismissed(preferences, "welcome", "0.3.1", true);
  assert.deepEqual(planStartup(preferences, "0.3.1").queue, []);
  const upgraded = planStartup(preferences, "0.4.0");
  assert.deepEqual(upgraded.queue, ["version"]);
  assert.deepEqual(planStartup(upgraded.preferences, "0.4.0").queue, ["version"]);
  preferences = setDismissed(upgraded.preferences, "version", "0.4.0", true);
  assert.deepEqual(planStartup(preferences, "0.4.0").queue, []);
  assert.deepEqual(planStartup(preferences, "0.4.1").queue, ["version"]);
});

test("welcome and update reminders remain independent and repeat until opted out", () => {
  const first = planStartup(parsePreferences(null), "0.3.1");
  const upgraded = planStartup(first.preferences, "0.3.2");
  assert.deepEqual(upgraded.queue, ["welcome", "version"]);
  const dismissed = setDismissed(upgraded.preferences, "version", "0.3.2", true);
  assert.deepEqual(planStartup(dismissed, "0.3.2").queue, ["welcome"]);
});

test("manual review can retain or change suppression without inventing an update", () => {
  const first = planStartup(parsePreferences(null), "0.3.1").preferences;
  const manual = setDismissed(first, "version", "0.3.1", false);
  assert.equal(manual.updateNoticeVersion, null);
  const suppressed = setDismissed(first, "welcome", "0.3.1", true);
  assert.equal(setDismissed(suppressed, "welcome", "0.3.1", false).welcomeDismissed, false);
  assert.equal(first.welcomeDismissed, false);
});

test("invalid settings recover safely and stored values are validated", () => {
  for (const value of [null, "", "broken", "null", "[]", "42", '{"welcomeDismissed":"false","lastVersion":42}']) {
    assert.deepEqual(planStartup(parsePreferences(value), "0.3.1").queue, ["welcome"]);
  }
  const preferences = setDismissed(planStartup(parsePreferences(null), "0.3.1").preferences, "welcome", "0.3.1", true);
  assert.deepEqual(parsePreferences(JSON.stringify(preferences)), preferences);
});
