import assert from 'node:assert/strict';
import { test } from 'node:test';

import { count, describe, next, parseCron, previous, wallClock } from '../lib/schedule.mjs';

const ZONE = 'America/Chicago';
const at = (iso) => new Date(iso);

test('every cron shape in the subset parses, normalizes, and reads in words', () => {
  for (const [line, normalized, words] of [
    ['30 6 * * 1-5', '30 6 * * 1-5', 'Weekdays at 6:30'],
    ['30 6 * * 5,1,2,3,4', '30 6 * * 1-5', 'Weekdays at 6:30'],
    ['30 6 * * mon-fri', '30 6 * * 1-5', 'Weekdays at 6:30'],
    ['0 18 * * *', '0 18 * * *', 'Every day at 18:00'],
    ['0 9 * * mon,thu', '0 9 * * 1,4', 'Every Monday and Thursday at 9:00'],
    ['0 9 * * 7', '0 9 * * 0', 'Every Sunday at 9:00'],
    ['0 9 * * SAT,SUN', '0 9 * * 0,6', 'Weekends at 9:00'],
    ['0 * * * *', '0 * * * *', 'Every hour'],
    ['15 * * * *', '15 * * * *', 'Every hour at :15'],
    ['*/30 * * * *', '*/30 * * * *', 'Every 30 minutes'],
    ['*/5 9-17 * * 1-5', '*/5 9-17 * * 1-5', 'Every 5 minutes from 9:00 to 17:59 on weekdays'],
    ['* * * * *', '* * * * *', 'Every minute'],
    ['0 */2 * * *', '0 */2 * * *', 'Every 2 hours'],
    ['0 */2 * * 0,6', '0 */2 * * 0,6', 'Every 2 hours on weekends'],
    ['0 8 1 * *', '0 8 1 * *', 'Monthly on the 1st at 8:00'],
    ['0 8 1,15 * *', '0 8 1,15 * *', 'Monthly on the 1st and 15th at 8:00'],
    ['0 8 1,15 1,7 *', '0 8 1,15 1,7 *', 'On the 1st and 15th in January and July at 8:00'],
    ['0 6,18 * * *', '0 6,18 * * *', 'Every day at 6:00 and 18:00'],
    ['0 6,12,18 * * *', '0 6,12,18 * * *', 'Every day at 6:00, 12:00, and 18:00'],
    ['0 9 * 3 *', '0 9 * 3 *', 'Every day in March at 9:00'],
    ['0 9 1 * 1', '0 9 1 * 1', 'Monday and the 1st at 9:00'],
  ]) {
    const cron = parseCron(line);
    assert.ok(cron, line);
    assert.equal(cron.line, normalized, line);
    assert.equal(describe(cron), words, line);
    assert.ok(Object.isFrozen(cron) && Object.isFrozen(cron.minute));
  }
});

test('lines outside the subset are null', () => {
  for (const line of [
    '*/3 * * * *', '*/60 * * * *', '0 */24 * * *', '0 9 */2 * *', '0 9 * */3 *', '0 9 * * */2', '0 9 1-5 * *', '0 9 * 1-3 *',
    '0 0 L * *', '0 0 * * 1-5/2', '0 0 1W * *', '0 0 * * 1#2', '0 9 * jan *', '1 2 3', '1 2 3 4 5 6', '', '0 25 * * *',
    '60 0 * * *', '0 0 0 * *', '0 0 32 * *', '0 0 * 13 *', '0 0 * * 8', '0 9 * * fri-mon', '0, 9 * * *', '0 9 * * ,1', 42, null,
  ]) {
    assert.equal(parseCron(line), null, String(line));
  }
});

test('next and previous walk weekdays in Chicago time', () => {
  const cron = parseCron('30 6 * * 1-5');
  // Friday 2026-10-02 07:00 CDT: the next weekday 6:30 is Monday.
  assert.equal(next(cron, at('2026-10-02T12:00:00Z'), ZONE).toISOString(), '2026-10-05T11:30:00.000Z');
  // Friday 06:00 CDT: today's 6:30.
  assert.equal(next(cron, at('2026-10-02T11:00:00Z'), ZONE).toISOString(), '2026-10-02T11:30:00.000Z');
  // Exactly at an occurrence: next is strictly after, previous is at or before.
  assert.equal(next(cron, at('2026-10-02T11:30:00Z'), ZONE).toISOString(), '2026-10-05T11:30:00.000Z');
  assert.equal(previous(cron, at('2026-10-02T11:30:00Z'), ZONE).toISOString(), '2026-10-02T11:30:00.000Z');
  // Saturday: the latest was Friday.
  assert.equal(previous(cron, at('2026-10-03T12:00:00Z'), ZONE).toISOString(), '2026-10-02T11:30:00.000Z');
  // A day that never comes.
  assert.equal(next(parseCron('0 0 31 2 *'), at('2026-10-02T12:00:00Z'), ZONE), null);
  assert.equal(previous(parseCron('0 0 31 2 *'), at('2026-10-02T12:00:00Z'), ZONE), null);
});

test('a minute the spring change skips does not fire; the next matching minute does', () => {
  // 2026-03-08 02:00 CST jumps to 03:00 CDT; 02:30 never happens that day.
  const cron = parseCron('30 2 * * *');
  assert.equal(next(cron, at('2026-03-07T18:00:00Z'), ZONE).toISOString(), '2026-03-09T07:30:00.000Z');
  assert.equal(previous(cron, at('2026-03-08T18:00:00Z'), ZONE).toISOString(), '2026-03-07T08:30:00.000Z');
  // Every hour at :30 fires at 01:30 CST and then 03:30 CDT.
  const hourly = parseCron('30 * * * *');
  assert.equal(next(hourly, at('2026-03-08T07:30:00Z'), ZONE).toISOString(), '2026-03-08T08:30:00.000Z');
  assert.equal(wallClock(at('2026-03-08T08:30:00Z'), ZONE).hour, 3);
});

test('a minute the fall change repeats fires once, at its first instant', () => {
  // 2026-11-01 01:30 happens at 06:30Z (CDT) and again at 07:30Z (CST).
  const cron = parseCron('30 1 * * *');
  assert.equal(next(cron, at('2026-10-31T17:00:00Z'), ZONE).toISOString(), '2026-11-01T06:30:00.000Z');
  assert.equal(next(cron, at('2026-11-01T06:30:00Z'), ZONE).toISOString(), '2026-11-02T07:30:00.000Z');
  assert.equal(previous(cron, at('2026-11-01T08:00:00Z'), ZONE).toISOString(), '2026-11-01T06:30:00.000Z');
  assert.equal(count(cron, at('2026-10-31T17:00:00Z'), at('2026-11-02T17:00:00Z'), ZONE, 10), 2);
});

test('count stops at max and counts the open-closed interval', () => {
  const cron = parseCron('30 6 * * 1-5');
  // Mon Sep 28 to Thu Oct 1 inclusive: 4 weekday mornings; from midnight UTC Sep 28 (Sunday evening) to Oct 1 00:00Z (Wed evening): Mon, Tue, Wed.
  assert.equal(count(cron, at('2026-09-28T00:00:00Z'), at('2026-10-01T00:00:00Z'), ZONE, 100), 3);
  assert.equal(count(cron, at('2026-01-01T00:00:00Z'), at('2026-10-01T00:00:00Z'), ZONE, 5), 5);
  assert.equal(count(cron, at('2026-10-02T11:30:00Z'), at('2026-10-02T11:30:00Z'), ZONE, 5), 0);
  assert.equal(count(cron, at('2026-10-02T11:29:00Z'), at('2026-10-02T11:30:00Z'), ZONE, 5), 1);
});

test('every minute resolves quickly and dates far out answer null', () => {
  const cron = parseCron('* * * * *');
  assert.equal(next(cron, at('2026-10-02T14:31:10Z'), ZONE).toISOString(), '2026-10-02T14:32:00.000Z');
  assert.equal(previous(cron, at('2026-10-02T14:31:10Z'), ZONE).toISOString(), '2026-10-02T14:31:00.000Z');
  // Leap day: more than 366 days out is null; within reach it is found.
  const feb29 = parseCron('0 0 29 2 *');
  assert.equal(next(feb29, at('2024-03-01T00:00:00Z'), ZONE), null);
  assert.equal(next(feb29, at('2027-03-01T00:00:00Z'), ZONE).toISOString(), '2028-02-29T06:00:00.000Z');
});
