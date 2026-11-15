// Pure report logic: no database or HTTP here, so it is easy to test.
// Input buckets are per-minute rows: { attendeeId, name, minuteStart, seconds: {STATE: n}, sleepEpisodes, drowsyEpisodes }.

export const STATES = ["FOCUSED", "DISTRACTED", "DROWSY", "SLEEPING", "ABSENT"];
export const SCORE = { FOCUSED: 100, DISTRACTED: 40, DROWSY: 25, SLEEPING: 0, ABSENT: 0 };

// An attendee counts as "attended" if their face was visible for at least this many seconds.
export const MIN_ATTENDED_SECONDS = 60;

const MINUTE_MS = 60000;
const round = (n, d = 0) => Math.round(n * 10 ** d) / 10 ** d;
const emptySeconds = () => Object.fromEntries(STATES.map(s => [s, 0]));
const toMs = d => new Date(d).getTime();

function sortByMinute(buckets) {
  return [...buckets].sort((a, b) => toMs(a.minuteStart) - toMs(b.minuteStart));
}

// Summary for one attendee (all of their buckets).
export function summarizeAttendee(buckets) {
  const rows = sortByMinute(buckets);
  const sec = emptySeconds();
  let sleep = 0, drowsy = 0, name = "Anonymous";
  for (const b of rows) {
    for (const s of STATES) sec[s] += b.seconds?.[s] || 0;
    sleep += b.sleepEpisodes || 0;
    drowsy += b.drowsyEpisodes || 0;
    if (b.name) name = b.name; // latest name wins
  }
  const total = STATES.reduce((a, s) => a + sec[s], 0);
  const present = total - sec.ABSENT;
  const scoreSum = STATES.reduce((a, s) => a + sec[s] * SCORE[s], 0);
  const first = rows.length ? toMs(rows[0].minuteStart) : null;
  const last = rows.length ? toMs(rows[rows.length - 1].minuteStart) + MINUTE_MS : null;

  return {
    name,
    firstSeen: first ? new Date(first).toISOString() : null,
    lastSeen: last ? new Date(last).toISOString() : null,
    seconds: sec,
    totalSeconds: total,
    presentSeconds: present,
    presentPct: total ? round((present / total) * 100) : 0,
    attentionPct: total ? round(scoreSum / total) : 0,
    sleepEpisodes: sleep,
    drowsyEpisodes: drowsy,
    attended: present >= MIN_ATTENDED_SECONDS
  };
}

// Overall meeting report plus one summary per attendee.
export function buildReport(buckets) {
  const byAttendee = new Map();
  for (const b of buckets) {
    if (!byAttendee.has(b.attendeeId)) byAttendee.set(b.attendeeId, []);
    byAttendee.get(b.attendeeId).push(b);
  }

  const attendees = [];
  for (const [attendeeId, rows] of byAttendee) {
    attendees.push({ attendeeId, ...summarizeAttendee(rows) });
  }
  attendees.sort((a, b) => a.name.localeCompare(b.name));

  // Meeting-wide state totals
  const sec = emptySeconds();
  let sleep = 0, drowsy = 0, scoreSum = 0;
  for (const a of attendees) {
    for (const s of STATES) sec[s] += a.seconds[s];
    sleep += a.sleepEpisodes;
    drowsy += a.drowsyEpisodes;
  }
  const total = STATES.reduce((a, s) => a + sec[s], 0);
  for (const s of STATES) scoreSum += sec[s] * SCORE[s];

  const stateShare = Object.fromEntries(
    STATES.map(s => [s, total ? round((sec[s] / total) * 100, 1) : 0])
  );

  // Per-minute meeting timeline: average attention across everyone present that minute
  const perMinute = new Map();
  for (const b of buckets) {
    const key = toMs(b.minuteStart);
    if (!perMinute.has(key)) perMinute.set(key, { sum: 0, sec: 0, people: new Set() });
    const m = perMinute.get(key);
    for (const s of STATES) {
      const v = b.seconds?.[s] || 0;
      m.sec += v;
      m.sum += v * SCORE[s];
    }
    if ((b.seconds?.ABSENT || 0) < 60) m.people.add(b.attendeeId);
  }
  const timeline = [...perMinute.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ms, m]) => ({
      minute: new Date(ms).toISOString(),
      attentionPct: m.sec ? round(m.sum / m.sec) : 0,
      peoplePresent: m.people.size
    }));

  const starts = attendees.map(a => a.firstSeen).filter(Boolean).sort();
  const ends = attendees.map(a => a.lastSeen).filter(Boolean).sort();

  return {
    overall: {
      attendees: attendees.length,
      attended: attendees.filter(a => a.attended).length,
      attendancePct: attendees.length
        ? round((attendees.filter(a => a.attended).length / attendees.length) * 100, 1)
        : 0,
      attentionPct: total ? round(scoreSum / total) : 0,
      trackedMinutes: round(total / 60, 1),
      stateSharePct: stateShare,
      sleepEpisodes: sleep,
      drowsyEpisodes: drowsy,
      start: starts[0] || null,
      end: ends[ends.length - 1] || null,
      timeline
    },
    attendees
  };
}

// Per-minute rows for one attendee, for the detail chart.
export function buildTimeline(buckets) {
  return sortByMinute(buckets).map(b => {
    const seconds = Object.fromEntries(STATES.map(s => [s, b.seconds?.[s] || 0]));
    const total = STATES.reduce((a, s) => a + seconds[s], 0);
    const score = STATES.reduce((a, s) => a + seconds[s] * SCORE[s], 0);
    return {
      minute: new Date(toMs(b.minuteStart)).toISOString(),
      seconds,
      attentionPct: total ? round(score / total) : 0,
      sleepEpisodes: b.sleepEpisodes || 0,
      drowsyEpisodes: b.drowsyEpisodes || 0
    };
  });
}
