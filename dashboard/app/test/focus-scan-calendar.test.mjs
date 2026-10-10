// The Focus calendar scan on fixture events: what the 48-hour window is
// allowed to put on the board, and how a start time is phrased. The Google
// client is a fake; nothing here calls Google.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../lib/config.mjs';
import { ScanError } from '../lib/focus/candidates.mjs';
import {
  keepEvent, candidateFromEvent, placeOf, formatStart, scan,
} from '../lib/focus/scans/calendar.mjs';

const NOW = Date.parse('2026-09-24T17:00:00Z'); // 12:00 noon in Chicago
const at = (hours) => new Date(NOW + hours * 3600_000).toISOString();

const event = (over = {}) => ({
  id: 'e1',
  summary: 'Coaching call',
  status: 'confirmed',
  htmlLink: 'https://www.google.com/calendar/event?eid=abc',
  start: { dateTime: at(3) },
  ...over,
});

test('an ordinary meeting is kept', () => {
  assert.equal(keepEvent(event(), NOW), true);
});

test('an event he declined is dropped', () => {
  const declined = event({ attendees: [{ email: 'other@example.com' }, { self: true, responseStatus: 'declined' }] });
  assert.equal(keepEvent(declined, NOW), false);
  const accepted = event({ attendees: [{ self: true, responseStatus: 'accepted' }] });
  assert.equal(keepEvent(accepted, NOW), true);
});

test('all-day entries and cancellations are dropped; "free" is kept (Gmail-lifted events are free by default)', () => {
  assert.equal(keepEvent(event({ start: { date: '2026-09-25' } }), NOW), false);
  assert.equal(keepEvent(event({ transparency: 'transparent' }), NOW), true);
  assert.equal(keepEvent(event({ status: 'cancelled' }), NOW), false);
});

test('a recurring instance only counts inside the next 4 hours', () => {
  const soon = event({ recurringEventId: 'r1', start: { dateTime: at(3) } });
  const later = event({ recurringEventId: 'r1', start: { dateTime: at(30) } });
  assert.equal(keepEvent(soon, NOW), true);
  assert.equal(keepEvent(later, NOW), false);
  // A one-off at the same distance stays: only routine repeats are filtered.
  assert.equal(keepEvent(event({ start: { dateTime: at(30) } }), NOW), true);
});

test('meta is the local start time, plus where', () => {
  assert.equal(formatStart('2026-09-24T19:00:00Z'), 'Thu 2:00 pm');
  const c = candidateFromEvent(event({ start: { dateTime: '2026-09-24T19:00:00Z' }, location: 'Neyland Stadium' }));
  assert.deepEqual(c, {
    title: 'Coaching call',
    source: 'calendar',
    external_id: 'e1',
    link: 'https://www.google.com/calendar/event?eid=abc',
    meta: 'Thu 2:00 pm · Neyland Stadium',
    occurs_at: '2026-09-24T19:00:00Z',
  });
});

test('conferencing is named, from the location or the invite', () => {
  assert.equal(placeOf({ location: 'https://us06web.zoom.us/j/123' }), 'Zoom');
  assert.equal(placeOf({ conferenceData: { entryPoints: [{ uri: 'https://meet.google.com/abc-def' }] } }), 'Meet');
  assert.equal(placeOf({}), null);
  assert.equal(candidateFromEvent(event({ start: { dateTime: '2026-09-24T19:00:00Z' } })).meta, 'Thu 2:00 pm');
});

test('a nameless event still gets a title, and a long one is truncated', () => {
  assert.equal(candidateFromEvent(event({ summary: '' })).title, '(no title)');
  assert.equal(candidateFromEvent(event({ summary: 'x'.repeat(250) })).title.length, 200);
});

function fakeGoogle(calendars, eventsById) {
  const calls = [];
  return {
    calls,
    async gapi(url, params = {}) {
      calls.push({ url, params });
      if (url.endsWith('/users/me/calendarList')) return { items: calendars };
      const id = decodeURIComponent(url.match(/calendars\/([^/]+)\/events$/)[1]);
      return { items: eventsById[id] ?? [] };
    },
  };
}

test('scan asks for the next 48 hours, skips the holiday calendar, and dedups across calendars', async () => {
  const shared = event({ id: 'shared', summary: 'Dinner', start: { dateTime: at(5) } });
  const google = fakeGoogle(
    [
      { id: 'me@example.com', summary: 'Me' },
      { id: 'family@group.example', summary: 'Family' },
      { id: 'holidays@group.example', summary: 'Holidays in United States' },
    ],
    {
      'me@example.com': [shared, event({ id: 'later', summary: 'Dentist', start: { dateTime: at(20) } })],
      'family@group.example': [shared, event({ id: 'gone', status: 'cancelled' })],
      'holidays@group.example': [event({ id: 'holiday', summary: 'A holiday' })],
    },
  );
  const candidates = await scan({ google, now: () => NOW, limits: LIMITS });
  assert.deepEqual(candidates.map((c) => c.external_id), ['shared', 'later']);
  const eventCalls = google.calls.filter((c) => c.url.endsWith('/events'));
  assert.equal(eventCalls.length, 2, 'the holiday calendar is never read');
  assert.equal(eventCalls[0].params.timeMin, new Date(NOW).toISOString());
  assert.equal(eventCalls[0].params.timeMax, new Date(NOW + 48 * 3600_000).toISOString());
  assert.equal(eventCalls[0].params.singleEvents, true);
});

test('scan output that fails validation throws a ScanError', async () => {
  const many = Array.from({ length: LIMITS.focusCandidatesMax + 1 }, (_, i) => event({ id: `e${i}` }));
  const google = fakeGoogle([{ id: 'me', summary: 'Me' }], { me: many });
  await assert.rejects(
    scan({ google, now: NOW, limits: LIMITS }),
    (error) => error instanceof ScanError && error.code === 'invalid_candidates',
  );
});
