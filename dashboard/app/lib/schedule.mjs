// Schedules: a cron subset, its rendering in words, and its occurrences in
// a time zone. A routine (routines.mjs) stores one cron line as the truth
// and the words this module renders from it; the scheduler (scheduler.mjs)
// asks for the latest occurrence at or before now and how many passed.
//
//   parseCron(line) -> cron | null
//     Five fields, whitespace-separated. Minute: `*`, N, lists, ranges,
//     `*/n` with n from 5 to 59. Hour: `*`, N, lists, ranges, `*/n` with n
//     from 1 to 23. Day of the month: `*`, N (1 to 31), lists. Month: `*`,
//     N (1 to 12), lists. Day of the week: `*`, 0 to 7 (7 is Sunday), the
//     names sun..sat, lists, ranges. Anything else (seconds, `L`, `W`, `#`,
//     month names, a step on a day field, a range with a step) is null.
//     The result is frozen: `line` is the normalized line (names lowered to
//     numbers, 7 to 0, lists sorted and deduplicated, runs of three or
//     more as ranges) and each field is { kind: 'any' | 'step' | 'list',
//     step, values } with `values` the sorted set the field allows.
//   describe(cron) -> text
//     The schedule in words, what a routine stores as `schedule.text`:
//     "Weekdays at 6:30", "Every day at 18:00", "Every Monday and Thursday
//     at 9:00", "Every hour", "Every 30 minutes", "Monthly on the 1st at
//     8:00"; a less common shape composes the same pieces ("Every 2 hours
//     on weekends", "On the 1st in January and July at 8:00").
//   next(cron, after, zone) -> Date | null
//     The first occurrence strictly after `after` in `zone` (an IANA name),
//     or null when none falls within the next 366 days.
//   previous(cron, at, zone) -> Date | null
//     The latest occurrence at or before `at`, or null when none fell
//     within the past 366 days.
//   count(cron, from, to, zone, max) -> number
//     Occurrences after `from` and at or before `to`, stopping at `max`.
//
// Wall-clock fields come from Intl.DateTimeFormat with hourCycle h23; a
// wall time becomes an instant by trying the zone's offsets around it and
// keeping those that read back as the same minute. A minute the spring
// change skips does not exist and does not fire (the next matching minute
// does); a minute the fall change repeats fires once, at its first instant.
// Enumeration walks days (at most 366), and within a matching day the hour
// and minute sets, so a `*/5` minute field costs nothing extra. Node has
// Intl and no Temporal; this is the whole of the zone arithmetic.

const DAY_MS = 86_400_000;
const MAX_DAYS = 366;
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DAY_WORDS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_WORDS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const FIELDS = [
  { key: 'minute', min: 0, max: 59, steps: true, stepMin: 5, ranges: true, names: null },
  { key: 'hour', min: 0, max: 23, steps: true, stepMin: 1, ranges: true, names: null },
  { key: 'dom', min: 1, max: 31, steps: false, ranges: false, names: null },
  { key: 'month', min: 1, max: 12, steps: false, ranges: false, names: null },
  { key: 'dow', min: 0, max: 7, steps: false, ranges: true, names: DAY_NAMES },
];

export function parseCron(line) {
  if (typeof line !== 'string') return null;
  const parts = line.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const cron = {};
  for (let i = 0; i < FIELDS.length; i += 1) {
    const field = parseField(parts[i], FIELDS[i]);
    if (!field) return null;
    cron[FIELDS[i].key] = Object.freeze(field);
  }
  cron.line = FIELDS.map((spec) => renderField(cron[spec.key], spec)).join(' ');
  return Object.freeze(cron);
}

function parseField(text, spec) {
  const range = (from, to, step = 1) => {
    const values = [];
    for (let v = from; v <= to; v += step) values.push(v);
    return values;
  };
  if (text === '*') return { kind: 'any', step: null, values: Object.freeze(range(spec.min, spec.max === 7 ? 6 : spec.max)) };
  const step = /^\*\/(\d{1,2})$/.exec(text);
  if (step) {
    if (!spec.steps) return null;
    const n = Number(step[1]);
    if (n < spec.stepMin || n > spec.max) return null;
    return { kind: 'step', step: n, values: Object.freeze(range(spec.min, spec.max, n)) };
  }
  const values = new Set();
  for (const part of text.split(',')) {
    if (part === '') return null;
    const bounds = /^([a-z0-9]+)-([a-z0-9]+)$/i.exec(part);
    if (bounds) {
      if (!spec.ranges) return null;
      const from = parseValue(bounds[1], spec);
      const to = parseValue(bounds[2], spec);
      if (from === null || to === null || from > to) return null;
      for (const v of range(from, to)) values.add(v);
    } else {
      const v = parseValue(part, spec);
      if (v === null) return null;
      values.add(v);
    }
  }
  if (values.size === 0) return null;
  return { kind: 'list', step: null, values: Object.freeze([...values].sort((a, b) => a - b)) };
}

// One value: a number in range, or a day name; 7 reads as Sunday.
function parseValue(text, spec) {
  if (/^\d{1,2}$/.test(text)) {
    const n = Number(text);
    if (n < spec.min || n > spec.max) return null;
    return spec.max === 7 && n === 7 ? 0 : n;
  }
  if (spec.names) {
    const index = spec.names.indexOf(text.toLowerCase());
    if (index !== -1) return index;
  }
  return null;
}

function renderField(field) {
  if (field.kind === 'any') return '*';
  if (field.kind === 'step') return `*/${field.step}`;
  const out = [];
  const values = field.values;
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j += 1;
    if (j - i >= 2) out.push(`${values[i]}-${values[j]}`);
    else for (let k = i; k <= j; k += 1) out.push(String(values[k]));
    i = j + 1;
  }
  return out.join(',');
}

export function describe(cron) {
  const { minute, hour, dom, month, dow } = cron;
  const monthPhrase = month.kind === 'any' ? null : `in ${words(month.values.map((m) => MONTH_WORDS[m - 1]))}`;
  const domPhrase = dom.kind === 'any' ? null : `the ${words(dom.values.map(ordinal))}`;
  const dowKey = dow.kind === 'any' || dow.values.length === 7 ? null : dow.values.join(',');
  const dowWord = dowKey === null ? null : dowKey === '1,2,3,4,5' ? 'weekdays' : dowKey === '0,6' ? 'weekends' : words(dow.values.map((d) => DAY_WORDS[d]));
  const dowNamed = dowKey !== null && dowWord !== 'weekdays' && dowWord !== 'weekends';

  // A time of day, or a cadence within the day.
  let cadence = null;
  let times = null;
  if (minute.kind === 'step') {
    cadence = `Every ${minute.step} minutes${hourWindow(hour)}`;
  } else if (minute.kind === 'any') {
    cadence = `Every minute${hourWindow(hour)}`;
  } else if (hour.kind === 'step') {
    const at = minute.values.length === 1 && minute.values[0] === 0 ? '' : ` at ${words(minute.values.map((m) => `:${pad(m)}`))}`;
    cadence = `Every ${hour.step === 1 ? 'hour' : `${hour.step} hours`}${at}`;
  } else if (hour.kind === 'any') {
    const at = minute.values.length === 1 && minute.values[0] === 0 ? '' : ` at ${words(minute.values.map((m) => `:${pad(m)}`))}`;
    cadence = `Every hour${at}`;
  } else {
    times = [];
    for (const h of hour.values) for (const m of minute.values) times.push(`${h}:${pad(m)}`);
  }

  if (cadence) {
    const on = [];
    if (dowWord) on.push(`on ${dowWord}`);
    if (domPhrase) on.push(`on ${domPhrase}`);
    if (monthPhrase) on.push(monthPhrase);
    return on.length === 0 ? cadence : `${cadence} ${on.join(' ')}`;
  }

  let days;
  if (dowWord && domPhrase) days = `${capitalize(dowWord)} and ${domPhrase}`;
  else if (dowWord) days = dowNamed ? `Every ${dowWord}` : capitalize(dowWord);
  else if (domPhrase) days = monthPhrase ? `On ${domPhrase}` : `Monthly on ${domPhrase}`;
  else days = 'Every day';
  if (monthPhrase) days = `${days} ${monthPhrase}`;
  return `${days} at ${words(times)}`;
}

// " from 9:00 to 17:59" for a contiguous hour window, " at hours 9, 13, and
// 17" otherwise, nothing for every hour.
function hourWindow(hour) {
  if (hour.kind === 'any') return '';
  if (hour.kind === 'step') return ` during every ${hour.step === 1 ? 'hour' : `${ordinal(hour.step)} hour`}`;
  const values = hour.values;
  const contiguous = values.every((h, i) => i === 0 || h === values[i - 1] + 1);
  if (contiguous) return ` from ${values[0]}:00 to ${values[values.length - 1]}:59`;
  return ` at hours ${words(values.map(String))}`;
}

function words(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

function ordinal(n) {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${suffix}`;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// Zone arithmetic.

const formatters = new Map();
function formatterFor(zone) {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

// The wall clock in `zone` at `date`.
export function wallClock(date, zone) {
  const parts = {};
  for (const part of formatterFor(zone).formatToParts(date)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year, month: parts.month, day: parts.day, hour: parts.hour % 24, minute: parts.minute, second: parts.second };
}

function offsetMs(ms, zone) {
  const w = wallClock(new Date(ms), zone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - ms;
}

// The earliest instant whose wall clock in `zone` is the given minute, or
// null when the zone skips that minute.
function instantOf(year, month, day, hour, minute, zone, offsets) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const candidates = new Set();
  for (const probe of [guess - DAY_MS, guess, guess + DAY_MS]) {
    const key = Math.floor(probe / 3_600_000);
    let offset = offsets.get(key);
    if (offset === undefined) {
      offset = offsetMs(probe, zone);
      offsets.set(key, offset);
    }
    candidates.add(guess - offset);
  }
  let best = null;
  for (const t of candidates) {
    const w = wallClock(new Date(t), zone);
    if (w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute && (best === null || t < best)) best = t;
  }
  return best === null ? null : new Date(best);
}

function dayMatches(cron, month, day, weekday) {
  if (cron.month.kind !== 'any' && !cron.month.values.includes(month)) return false;
  const domAny = cron.dom.kind === 'any';
  const dowAny = cron.dow.kind === 'any';
  if (domAny && dowAny) return true;
  const domOk = cron.dom.values.includes(day);
  const dowOk = cron.dow.values.includes(weekday);
  if (domAny) return dowOk;
  if (dowAny) return domOk;
  return domOk || dowOk;
}

function dayOf(dayNumber) {
  const date = new Date(dayNumber * DAY_MS);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(), weekday: date.getUTCDay() };
}

export function next(cron, after, zone) {
  const afterMs = after.getTime();
  const start = wallClock(after, zone);
  const startDay = Math.floor(Date.UTC(start.year, start.month - 1, start.day) / DAY_MS);
  const offsets = new Map();
  for (let k = 0; k <= MAX_DAYS; k += 1) {
    const { year, month, day, weekday } = dayOf(startDay + k);
    if (!dayMatches(cron, month, day, weekday)) continue;
    for (const h of cron.hour.values) {
      if (k === 0 && h < start.hour - 1) continue;
      for (const m of cron.minute.values) {
        const t = instantOf(year, month, day, h, m, zone, offsets);
        if (t && t.getTime() > afterMs) return t;
      }
    }
  }
  return null;
}

export function previous(cron, at, zone) {
  const atMs = at.getTime();
  const start = wallClock(at, zone);
  const startDay = Math.floor(Date.UTC(start.year, start.month - 1, start.day) / DAY_MS);
  const offsets = new Map();
  const hours = [...cron.hour.values].reverse();
  const minutes = [...cron.minute.values].reverse();
  for (let k = 0; k <= MAX_DAYS; k += 1) {
    const { year, month, day, weekday } = dayOf(startDay - k);
    if (!dayMatches(cron, month, day, weekday)) continue;
    for (const h of hours) {
      if (k === 0 && h > start.hour + 1) continue;
      for (const m of minutes) {
        const t = instantOf(year, month, day, h, m, zone, offsets);
        if (t && t.getTime() <= atMs) return t;
      }
    }
  }
  return null;
}

export function count(cron, from, to, zone, max) {
  let n = 0;
  let cursor = from;
  while (n < max) {
    const t = next(cron, cursor, zone);
    if (!t || t.getTime() > to.getTime()) break;
    n += 1;
    cursor = t;
  }
  return n;
}
