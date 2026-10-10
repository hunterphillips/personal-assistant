// Focus calendar scan: every calendar except the holiday feed, events between
// now and now+48h, mechanically filtered. scan({ google, now, limits, signal })
// resolves the validated candidates, soonest first, or throws. It never writes
// anything and never judges importance; the curator does.
//
// The window is arithmetic, so it belongs in code: asked for "the next 48
// hours" a model anchored to midnight and lost the far end of the range.

import { checkedCandidates } from '../candidates.mjs';

const API = 'https://www.googleapis.com/calendar/v3';
const WINDOW_MS = 48 * 60 * 60 * 1000;
// A recurring instance is routine (standup, gym block) and only worth a card
// when it is nearly here.
const RECURRING_HORIZON_MS = 4 * 60 * 60 * 1000;
const MAX_EVENTS_PER_CALENDAR = 100;
const MAX_LOCATION = 60;

const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Chicago',
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

// ---- filtering ------------------------------------------------------------

export function keepEvent(event, now = Date.now()) {
  if (!event || event.status === 'cancelled') return false;
  // All-day entries ("stay", holds, birthdays) carry no moment to act on.
  const start = event.start?.dateTime;
  if (!start) return false;
  const startMs = Date.parse(start);
  if (!Number.isFinite(startMs)) return false;

  if ((event.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined')) return false;
  // "Free" (transparent) is not a drop rule: Google marks every event it lifts
  // out of Gmail (tickets, reservations) free by default, and those are the
  // ones most likely to need something done beforehand. The curator judges.
  if (event.recurringEventId && startMs - now > RECURRING_HORIZON_MS) return false;
  return true;
}

// ---- formatting -----------------------------------------------------------

function truncate(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

// "Tue 2:00 pm" in his timezone. Built from parts because en-US renders
// "Tue, 2:00 PM" and the board's voice is lowercase meridiem, no comma.
export function formatStart(start) {
  const parts = timeFormat.formatToParts(new Date(start));
  const get = (type) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('weekday')} ${get('hour')}:${get('minute')} ${get('dayPeriod').toLowerCase()}`;
}

const CONFERENCES = [
  [/zoom\.us/i, 'Zoom'],
  [/meet\.google\.com/i, 'Meet'],
  [/teams\.microsoft\.com/i, 'Teams'],
];

// Where it happens: the location line if there is one, else the conferencing
// hint the invite carries.
export function placeOf(event) {
  const location = String(event.location ?? '').trim();
  if (location) {
    for (const [re, name] of CONFERENCES) if (re.test(location)) return name;
    return truncate(location.split('\n')[0], MAX_LOCATION);
  }
  const uris = (event.conferenceData?.entryPoints ?? []).map((e) => e.uri ?? '').join(' ');
  for (const [re, name] of CONFERENCES) if (re.test(uris)) return name;
  const solution = event.conferenceData?.conferenceSolution?.name;
  return solution ? truncate(solution, MAX_LOCATION) : null;
}

export function candidateFromEvent(event) {
  const start = event.start.dateTime;
  const place = placeOf(event);
  return {
    title: truncate(event.summary || '(no title)', 200),
    source: 'calendar',
    external_id: event.id,
    link: event.htmlLink ?? null,
    meta: place ? `${formatStart(start)} · ${place}` : formatStart(start),
    occurs_at: start,
  };
}

// ---- the scan -------------------------------------------------------------

export async function scan({ google, now = Date.now, limits, signal } = {}) {
  const nowMs = typeof now === 'function' ? now() : Number(now);
  const timeMin = new Date(nowMs).toISOString();
  const timeMax = new Date(nowMs + WINDOW_MS).toISOString();

  const list = await google.gapi(`${API}/users/me/calendarList`, {}, { signal });
  const calendars = (list.items ?? []).filter((c) => !/holidays/i.test(c.summaryOverride || c.summary || ''));

  const events = [];
  const seen = new Set(); // the same event can sit on two of his calendars
  for (const cal of calendars) {
    const data = await google.gapi(`${API}/calendars/${encodeURIComponent(cal.id)}/events`, {
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: MAX_EVENTS_PER_CALENDAR,
    }, { signal });
    for (const event of data.items ?? []) {
      if (!keepEvent(event, nowMs)) continue;
      const key = `${event.id}:${event.start?.dateTime ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }

  const candidates = events
    .map(candidateFromEvent)
    .sort((a, b) => Date.parse(a.occurs_at) - Date.parse(b.occurs_at));
  return checkedCandidates(candidates, limits);
}
