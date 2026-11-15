import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport, buildTimeline } from "../src/report.js";

const row = (attendeeId, name, minute, seconds, extra = {}) => ({
  attendeeId, name, minuteStart: new Date(minute), seconds: { FOCUSED: 0, DISTRACTED: 0, DROWSY: 0, SLEEPING: 0, ABSENT: 0, ...seconds },
  sleepEpisodes: 0, drowsyEpisodes: 0, ...extra
});
const M0 = Date.UTC(2026, 10, 14, 10, 0);
const M1 = M0 + 60000;

test("attendee summary: attention, presence, episodes", () => {
  const r = buildReport([
    row("a1", "Asha", M0, { FOCUSED: 60 }),
    row("a1", "Asha", M1, { FOCUSED: 30, SLEEPING: 30 }, { sleepEpisodes: 1 })
  ]);
  const a = r.attendees[0];
  assert.equal(a.name, "Asha");
  assert.equal(a.totalSeconds, 120);
  assert.equal(a.presentPct, 100);
  assert.equal(a.attentionPct, 75);       // (60*100 + 30*100 + 30*0) / 120
  assert.equal(a.sleepEpisodes, 1);
  assert.equal(a.attended, true);
});

test("overall: attendance excludes people absent most of the time", () => {
  const r = buildReport([
    row("a1", "Asha", M0, { FOCUSED: 60 }),
    row("a2", "Ben", M0, { ABSENT: 60 }),          // never present
    row("a3", "Chen", M0, { ABSENT: 50, FOCUSED: 10 }) // present 10 s only
  ]);
  assert.equal(r.overall.attendees, 3);
  assert.equal(r.overall.attended, 1);
  assert.equal(r.overall.attendancePct, 33.3);
});

test("overall: state shares and per-minute timeline", () => {
  const r = buildReport([
    row("a1", "Asha", M0, { FOCUSED: 60 }),
    row("a2", "Ben", M0, { DROWSY: 60 }),
    row("a1", "Asha", M1, { DISTRACTED: 60 })
  ]);
  assert.equal(r.overall.stateSharePct.FOCUSED, 33.3); // 60 of 180 s
  assert.equal(r.overall.stateSharePct.DROWSY, 33.3);
  assert.equal(r.overall.timeline.length, 2);
  assert.equal(r.overall.timeline[0].attentionPct, 63); // (100*60 + 25*60) / 120 = 62.5, rounded
  assert.equal(r.overall.timeline[0].peoplePresent, 2);
});

test("empty meeting yields zeros without errors", () => {
  const r = buildReport([]);
  assert.equal(r.overall.attendees, 0);
  assert.equal(r.overall.attentionPct, 0);
  assert.deepEqual(r.attendees, []);
});

test("timeline for one attendee is sorted and scored per minute", () => {
  const t = buildTimeline([
    row("a1", "Asha", M1, { DISTRACTED: 60 }),
    row("a1", "Asha", M0, { FOCUSED: 60 })
  ]);
  assert.equal(t[0].minute, new Date(M0).toISOString());
  assert.equal(t[0].attentionPct, 100);
  assert.equal(t[1].attentionPct, 40);
});
