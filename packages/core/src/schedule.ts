/**
 * Routine schedules: a small dependency-free 5-field cron implementation with IANA time zones (via
 * Intl), plus interval and one-shot schedules.
 *
 * Cron fields: minute (0-59) hour (0-23) day-of-month (1-31) month (1-12 or JAN-DEC)
 * day-of-week (0-7 or SUN-SAT; 0 and 7 are Sunday). Each field accepts `*`, `n`, `a-b`, `*\/s`,
 * `a-b/s`, `a/s` and comma lists. As in Vixie cron, when both day fields are restricted (neither
 * starts with `*`) a day matches if EITHER matches.
 *
 * Daylight-saving rules (deterministic, cronie-like):
 * - Fixed-time jobs (hour field does not start with `*`): a local time that does not exist (spring
 *   gap) fires shifted forward by the gap length (02:30 → 03:30), like Temporal's `compatible`
 *   disambiguation; a local time that occurs twice (autumn overlap) fires once, at its first
 *   occurrence.
 * - Wildcard-hour jobs (hour field starts with `*`): fire on real wall-clock matches only; minutes
 *   inside a gap do not exist, and repeated wall-clock minutes fire in both passes.
 */
import type { RoutineSchedule } from '@your-bot/contracts';
import { GatewayError } from './validation.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Larger than any DST shift in the tz database (2 h). */
const SHIFT_WINDOW = 3 * HOUR;
const SEARCH_YEARS = 9;

export interface CronSpec {
  minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>;
  domRestricted: boolean; dowRestricted: boolean; wildcardHour: boolean;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function invalid(message: string): never { throw new GatewayError('INVALID_INPUT', `Invalid cron expression: ${message}`); }

function parseField(text: string, min: number, max: number, names?: string[], nameBase = 0): Set<number> {
  const values = new Set<number>();
  const value = (token: string): number => {
    const upper = token.toUpperCase();
    if (names) { const index = names.indexOf(upper); if (index >= 0) return index + nameBase; }
    if (!/^\d{1,2}$/.test(token)) invalid(`bad value "${token.slice(0, 16)}"`);
    const number = Number(token);
    if (number < min || number > max) invalid(`value ${number} out of range ${min}-${max}`);
    return number;
  };
  for (const part of text.split(',')) {
    if (!part) invalid('empty list item');
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) invalid('bad step');
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d{1,3}$/.test(stepText) || Number(stepText) < 1) invalid('bad step');
      step = Number(stepText);
    }
    let from: number; let to: number;
    if (range === '*') { from = min; to = max; }
    else if (range.includes('-')) {
      const [a, b, more] = range.split('-');
      if (more !== undefined || !a || !b) invalid('bad range');
      from = value(a); to = value(b);
      if (from > to) invalid('descending range');
    } else { from = value(range); to = stepText !== undefined ? max : from; }
    for (let item = from; item <= to; item += step) values.add(item);
  }
  return values;
}

export function parseCron(expression: string): CronSpec {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) invalid('expected 5 fields');
  const [minute, hour, dom, month, dow] = fields;
  const days = parseField(dow, 0, 7, DAYS);
  if (days.has(7)) { days.delete(7); days.add(0); }
  return {
    minute: parseField(minute, 0, 59), hour: parseField(hour, 0, 23), dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12, MONTHS, 1), dow: days,
    domRestricted: !dom.startsWith('*'), dowRestricted: !dow.startsWith('*'), wildcardHour: hour.startsWith('*'),
  };
}

/* ----------------------------------------------------------------- time zones */

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    try {
      format = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch { throw new GatewayError('INVALID_INPUT', 'Unknown time zone'); }
    if (formatters.size > 256) formatters.clear();
    formatters.set(timeZone, format);
  }
  return format;
}
export function hostTimeZone(): string { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; }
export function validTimeZone(timeZone: string): boolean { try { formatter(timeZone); return true; } catch { return false; } }

/** Local wall-clock time of `instant` in `timeZone`, encoded as epoch ms of the same fields in UTC. */
export function wallTime(instant: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) if (part.type !== 'literal') parts[part.type] = Number(part.value);
  const year = parts.year; // Era is not requested: years are positive for any realistic schedule.
  return Date.UTC(year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) + (instant - Math.floor(instant / 1000) * 1000);
}
function offsetAt(instant: number, timeZone: string): number { return wallTime(instant, timeZone) - instant; }

/**
 * UTC instants whose local wall time is `wall` (minute precision): one normally, two in an overlap,
 * none in a gap. `gapShift` receives the gap-shifted instant for nonexistent times.
 */
function instantsFor(wall: number, timeZone: string): {instants: number[]; shifted?: number} {
  // `wall - offset` is within one DST shift of the true instant; sample offsets around it.
  const guess = wall - offsetAt(wall, timeZone);
  const offsets = new Set([offsetAt(guess - SHIFT_WINDOW, timeZone), offsetAt(guess, timeZone), offsetAt(guess + SHIFT_WINDOW, timeZone)]);
  const instants = [...offsets].map(offset => wall - offset).filter(instant => wallTime(instant, timeZone) === wall);
  const unique = [...new Set(instants)].sort((a, b) => a - b);
  if (unique.length) return { instants: unique };
  // Gap: apply the offset in effect before the transition (the smaller one), which lands after it.
  const before = Math.min(...offsets);
  return { instants: [], shifted: wall - before };
}

/** Smallest wall time ≥ `wall` (minute aligned) matching the spec, or undefined within the search horizon. */
function nextWallMatch(spec: CronSpec, wall: number): number | undefined {
  let date = new Date(Math.ceil(wall / MINUTE) * MINUTE);
  const limit = date.getUTCFullYear() + SEARCH_YEARS;
  const dayMatches = (d: Date) => {
    const dom = spec.dom.has(d.getUTCDate()); const dow = spec.dow.has(d.getUTCDay());
    if (spec.domRestricted && spec.dowRestricted) return dom || dow;
    return dom && dow;
  };
  for (let guard = 0; guard < 200_000; guard++) {
    if (date.getUTCFullYear() > limit) return undefined;
    if (!spec.month.has(date.getUTCMonth() + 1)) { date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)); continue; }
    if (!dayMatches(date)) { date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)); continue; }
    if (!spec.hour.has(date.getUTCHours())) { date = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours() + 1)); continue; }
    if (!spec.minute.has(date.getUTCMinutes())) { date = new Date(date.getTime() + MINUTE); continue; }
    return date.getTime();
  }
  return undefined;
}

/** Instants at which a cron spec fires for local wall time `wall` (see DST rules above). */
function cronInstants(spec: CronSpec, wall: number, timeZone: string): number[] {
  const { instants, shifted } = instantsFor(wall, timeZone);
  if (spec.wildcardHour) return instants;
  if (instants.length) return [instants[0]];
  return shifted !== undefined ? [shifted] : [];
}

/** First firing instant strictly after `after`. */
export function nextCron(spec: CronSpec, timeZone: string, after: number): number | undefined {
  const near = new Set([offsetAt(after - 26 * HOUR, timeZone), offsetAt(after, timeZone), offsetAt(after + 26 * HOUR, timeZone)]).size > 1;
  // Near a transition, local order and instant order can differ: scan a window and keep the minimum.
  let wall = nextWallMatch(spec, wallTime(after, timeZone) - (near ? SHIFT_WINDOW : 0) + (near ? 0 : 1));
  let best: number | undefined;
  for (let guard = 0; wall !== undefined && guard < 100_000; guard++) {
    if (best !== undefined && wall > wallTime(best, timeZone) + SHIFT_WINDOW) break;
    for (const instant of cronInstants(spec, wall, timeZone)) if (instant > after && (best === undefined || instant < best)) best = instant;
    if (best !== undefined && !near) break;
    wall = nextWallMatch(spec, wall + MINUTE);
  }
  return best;
}

/* -------------------------------------------------------------- schedules */

export interface ScheduleState {
  schedule: RoutineSchedule;
  /** Interval anchor (epoch ms): occurrences are anchor + k·period, k ≥ 1. */
  anchor: number;
}

/** Throws INVALID_INPUT for an unusable schedule (bad cron, unknown time zone, no future occurrence). */
export function checkSchedule(schedule: RoutineSchedule, now: number): void {
  if (schedule.kind === 'cron') {
    const spec = parseCron(schedule.expression);
    if (schedule.timezone !== undefined && !validTimeZone(schedule.timezone)) throw new GatewayError('INVALID_INPUT', 'Unknown time zone');
    if (nextCron(spec, schedule.timezone ?? hostTimeZone(), now) === undefined) throw new GatewayError('INVALID_INPUT', 'Cron expression never fires');
  } else if (schedule.kind === 'once' && Date.parse(schedule.at) <= now) {
    throw new GatewayError('INVALID_INPUT', 'A one-time schedule must be in the future');
  }
}

const specs = new Map<string, CronSpec>();
/** First occurrence strictly after `after`, or undefined when the schedule is exhausted. */
export function nextOccurrence(state: ScheduleState, after: number): number | undefined {
  const { schedule } = state;
  switch (schedule.kind) {
    case 'interval': {
      const period = schedule.everyMinutes * MINUTE;
      const steps = Math.max(1, Math.floor((after - state.anchor) / period) + 1);
      return state.anchor + steps * period;
    }
    case 'once': { const at = Date.parse(schedule.at); return at > after ? at : undefined; }
    case 'cron': {
      let spec = specs.get(schedule.expression);
      if (!spec) { spec = parseCron(schedule.expression); if (specs.size > 256) specs.clear(); specs.set(schedule.expression, spec); }
      return nextCron(spec, schedule.timezone ?? hostTimeZone(), after);
    }
  }
}

/**
 * The latest `limit` occurrences t with from ≤ t < to, oldest first. Long ranges are searched in
 * growing windows ending at `to`, so a week of downtime with a one-minute schedule stays cheap.
 */
export function latestOccurrences(state: ScheduleState, from: number, to: number, limit: number): number[] {
  if (limit <= 0 || from >= to) return [];
  for (let span = HOUR; ; span *= 8) {
    const start = Math.max(from, to - span);
    const found: number[] = [];
    let t = nextOccurrence(state, start - 1);
    for (let guard = 0; t !== undefined && t < to && guard < 1_000_000; guard++) {
      found.push(t); if (found.length > limit) found.shift();
      t = nextOccurrence(state, t);
    }
    if (found.length >= limit || start === from) return found;
  }
}
