import { describe, expect, it } from 'vitest';
import type { RoutineSchedule } from '@your-bot/contracts';
import { checkSchedule, latestOccurrences, nextOccurrence, parseCron, type ScheduleState } from './schedule.js';

const t = (iso: string) => Date.parse(iso);
const iso = (ms: number | undefined) => ms === undefined ? undefined : new Date(ms).toISOString();
const cron = (expression: string, timezone?: string): ScheduleState => ({ schedule: { kind: 'cron', expression, ...(timezone ? { timezone } : {}) }, anchor: 0 });
/** The next `count` firing instants after `from`. */
function sequence(state: ScheduleState, from: string, count: number): string[] {
  const result: string[] = []; let at = t(from);
  for (let i = 0; i < count; i++) { const next = nextOccurrence(state, at); if (next === undefined) break; result.push(iso(next)!); at = next; }
  return result;
}

describe('cron parsing', () => {
  it('accepts lists, ranges, steps and names, and rejects malformed fields', () => {
    const spec = parseCron('0,30 9-17/2 */10 JAN-mar sun,6');
    expect([...spec.minute]).toEqual([0, 30]);
    expect([...spec.hour]).toEqual([9, 11, 13, 15, 17]);
    expect([...spec.dom]).toEqual([1, 11, 21, 31]);
    expect([...spec.month]).toEqual([1, 2, 3]);
    expect([...spec.dow].sort()).toEqual([0, 6]);
    expect([...parseCron('* * * * 7').dow]).toEqual([0]);
    expect([...parseCron('5/20 * * * *').minute]).toEqual([5, 25, 45]);
    for (const bad of ['61 * * * *', '* * * *', '* * * * * *', '*/0 * * * *', '5-1 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', 'a * * * *', '1,,2 * * * *', '1-2-3 * * * *', '*/5/2 * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    }
  });
});

describe('cron next run', () => {
  it('computes UTC occurrences, weekday ranges and the Vixie day-of-month OR day-of-week rule', () => {
    expect(sequence(cron('*/15 * * * *', 'UTC'), '2026-11-15T10:07:31.000Z', 3)).toEqual(['2026-11-15T10:15:00.000Z', '2026-11-15T10:30:00.000Z', '2026-11-15T10:45:00.000Z']);
    // 2026-11-14 is a Saturday.
    expect(sequence(cron('0 9 * * 1-5', 'UTC'), '2026-11-14T12:00:00.000Z', 2)).toEqual(['2026-11-16T09:00:00.000Z', '2026-11-17T09:00:00.000Z']);
    // Both day fields restricted: the 13th OR any Friday.
    expect(sequence(cron('0 0 13 * 5', 'UTC'), '2026-11-15T00:00:00.000Z', 3)).toEqual(['2026-11-20T00:00:00.000Z', '2026-11-27T00:00:00.000Z', '2026-12-04T00:00:00.000Z']);
    expect(sequence(cron('0 0 13 * *', 'UTC'), '2026-11-15T00:00:00.000Z', 1)).toEqual(['2026-12-13T00:00:00.000Z']);
    // Leap day.
    expect(sequence(cron('0 12 29 2 *', 'UTC'), '2026-11-15T00:00:00.000Z', 2)).toEqual(['2028-02-29T12:00:00.000Z', '2032-02-29T12:00:00.000Z']);
    // An occurrence exactly at `after` is not repeated.
    expect(iso(nextOccurrence(cron('0 * * * *', 'UTC'), t('2026-11-15T10:00:00.000Z')))).toBe('2026-11-15T11:00:00.000Z');
  });

  it('applies IANA time zones, including half-hour offsets and day boundaries', () => {
    expect(sequence(cron('0 9 * * *', 'America/New_York'), '2026-01-10T00:00:00.000Z', 1)).toEqual(['2026-01-10T14:00:00.000Z']);
    expect(sequence(cron('0 9 * * *', 'America/New_York'), '2026-07-10T00:00:00.000Z', 1)).toEqual(['2026-07-10T13:00:00.000Z']);
    expect(sequence(cron('30 8 * * *', 'Asia/Kolkata'), '2026-11-15T00:00:00.000Z', 2)).toEqual(['2026-11-15T03:00:00.000Z', '2026-11-16T03:00:00.000Z']);
    // Monday 07:00 in Sydney (UTC+11 in November) is Sunday 20:00 UTC.
    expect(sequence(cron('0 7 * * 1', 'Australia/Sydney'), '2026-11-15T00:00:00.000Z', 1)).toEqual(['2026-11-15T20:00:00.000Z']);
    expect(sequence(cron('0 0 1 * *', 'Pacific/Kiritimati'), '2026-11-15T00:00:00.000Z', 1)).toEqual(['2026-11-30T10:00:00.000Z']);
  });

  it('fires fixed-time jobs in a spring-forward gap shifted by the gap, and wildcard-hour jobs only on real wall times', () => {
    // America/New_York: 2026-03-08 02:00 EST → 03:00 EDT.
    expect(sequence(cron('30 2 * * *', 'America/New_York'), '2026-03-07T12:00:00.000Z', 3)).toEqual([
      '2026-03-08T07:30:00.000Z', // 02:30 does not exist → 03:30 EDT
      '2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z',
    ]);
    expect(sequence(cron('30 * * * *', 'America/New_York'), '2026-03-08T05:00:00.000Z', 3)).toEqual([
      '2026-03-08T05:30:00.000Z', // 00:30 EST
      '2026-03-08T06:30:00.000Z', // 01:30 EST
      '2026-03-08T07:30:00.000Z', // 03:30 EDT (02:30 skipped)
    ]);
    // Europe/London: 2026-03-29 01:00 GMT → 02:00 BST.
    expect(sequence(cron('30 1 * * *', 'Europe/London'), '2026-03-28T12:00:00.000Z', 2)).toEqual(['2026-03-29T01:30:00.000Z', '2026-03-30T00:30:00.000Z']);
  });

  it('fires fixed-time jobs once in an autumn overlap and wildcard-hour jobs in both passes', () => {
    // America/New_York: 2026-11-01 02:00 EDT → 01:00 EST, so 01:00-01:59 happens twice.
    expect(sequence(cron('30 1 * * *', 'America/New_York'), '2026-10-31T12:00:00.000Z', 2)).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z']);
    expect(sequence(cron('0,30 * * * *', 'America/New_York'), '2026-11-01T04:45:00.000Z', 6)).toEqual([
      '2026-11-01T05:00:00.000Z', '2026-11-01T05:30:00.000Z', // 01:00, 01:30 EDT
      '2026-11-01T06:00:00.000Z', '2026-11-01T06:30:00.000Z', // 01:00, 01:30 EST
      '2026-11-01T07:00:00.000Z', '2026-11-01T07:30:00.000Z', // 02:00, 02:30 EST
    ]);
    // Starting inside the second pass, a fixed 01:45 job does not fire again that day.
    expect(sequence(cron('45 1 * * *', 'America/New_York'), '2026-11-01T06:10:00.000Z', 1)).toEqual(['2026-11-02T06:45:00.000Z']);
    // Europe/Berlin: 2026-10-25 03:00 CEST → 02:00 CET.
    expect(sequence(cron('15 2 * * *', 'Europe/Berlin'), '2026-10-24T12:00:00.000Z', 2)).toEqual(['2026-10-25T00:15:00.000Z', '2026-10-26T01:15:00.000Z']);
  });
});

describe('schedules', () => {
  it('computes interval occurrences from the anchor and one-time schedules once', () => {
    const interval: ScheduleState = { schedule: { kind: 'interval', everyMinutes: 90 }, anchor: t('2026-11-15T10:00:00.000Z') };
    expect(iso(nextOccurrence(interval, t('2026-11-15T10:00:00.000Z')))).toBe('2026-11-15T11:30:00.000Z');
    expect(iso(nextOccurrence(interval, t('2026-11-15T09:00:00.000Z')))).toBe('2026-11-15T11:30:00.000Z');
    expect(iso(nextOccurrence(interval, t('2026-11-15T13:00:00.000Z')))).toBe('2026-11-15T14:30:00.000Z');
    const once: ScheduleState = { schedule: { kind: 'once', at: '2026-11-20T08:00:00.000Z' }, anchor: 0 };
    expect(iso(nextOccurrence(once, t('2026-11-15T00:00:00.000Z')))).toBe('2026-11-20T08:00:00.000Z');
    expect(nextOccurrence(once, t('2026-11-20T08:00:00.000Z'))).toBeUndefined();
  });

  it('returns the latest missed occurrences quickly even after long downtime', () => {
    const started = performance.now();
    const minutely = cron('* * * * *', 'Europe/Paris');
    expect(latestOccurrences(minutely, t('2026-11-01T00:00:00.000Z'), t('2026-11-15T00:00:00.000Z'), 3).map(iso)).toEqual([
      '2026-11-14T23:57:00.000Z', '2026-11-14T23:58:00.000Z', '2026-11-14T23:59:00.000Z',
    ]);
    const yearly = cron('0 0 1 1 *', 'UTC');
    expect(latestOccurrences(yearly, t('2020-01-01T00:00:00.000Z'), t('2026-11-15T00:00:00.000Z'), 2).map(iso)).toEqual(['2025-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']);
    expect(latestOccurrences(yearly, t('2025-06-01T00:00:00.000Z'), t('2026-11-15T00:00:00.000Z'), 5).map(iso)).toEqual(['2026-01-01T00:00:00.000Z']);
    const interval: ScheduleState = { schedule: { kind: 'interval', everyMinutes: 1 }, anchor: 0 };
    expect(latestOccurrences(interval, 60_000, 365 * 24 * 3_600_000, 2)).toEqual([365 * 24 * 3_600_000 - 120_000, 365 * 24 * 3_600_000 - 60_000]);
    expect(latestOccurrences(minutely, 0, 1, 0)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(3000);
  });

  it('rejects unknown time zones, crons that never fire and one-time schedules in the past', () => {
    const now = t('2026-11-15T00:00:00.000Z');
    const bad: RoutineSchedule[] = [
      { kind: 'cron', expression: '0 9 * * *', timezone: 'Mars/Olympus' },
      { kind: 'cron', expression: '0 0 30 2 *', timezone: 'UTC' },
      { kind: 'cron', expression: '0 25 * * *' },
      { kind: 'once', at: '2026-11-14T00:00:00.000Z' },
    ];
    for (const schedule of bad) expect(() => checkSchedule(schedule, now), JSON.stringify(schedule)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => checkSchedule({ kind: 'cron', expression: '0 9 * * *' }, now)).not.toThrow();
  });
});
