/**
 * Port of `programs/deliverable/src/calendar.rs`: unix time to US Eastern civil time
 * to trading session, with no date library, so the verdict is the program's to the
 * second. Integer division in the Rust is truncating (`/`) or Euclidean
 * (`div_euclid`/`rem_euclid`) and each is reproduced as written.
 */

/** `ENTRY_CLOSED` / `ENTRY_EARLY_CLOSE` in state/registry.rs. */
export const ENTRY_CLOSED = 0;
export const ENTRY_EARLY_CLOSE = 1;

/** `constants::REGULAR_OPEN_MINUTE` / `REGULAR_CLOSE_MINUTE`. */
export const REGULAR_OPEN_MINUTE = 9 * 60 + 30;
export const REGULAR_CLOSE_MINUTE = 16 * 60;

/** `constants::MAX_SESSION_SCAN_DAYS`. */
export const MAX_SESSION_SCAN_DAYS = 16;

const SECONDS_PER_DAY = 86_400;
const U32_MAX = 0xffff_ffff;

export interface CalendarEntryLike {
  /** `(month << 8) | day`. */
  dateKey: number;
  kind: number;
  closeMinute: number;
}

/** The fields of `MarketCalendar` the session logic reads. The decoded account satisfies it. */
export interface CalendarLike {
  regularOpenMinute: number;
  regularCloseMinute: number;
  entries: readonly CalendarEntryLike[];
}

export type Session = 'Closed' | 'Regular';

const closed = (month: number, day: number): CalendarEntryLike => ({
  dateKey: (month << 8) | day,
  kind: ENTRY_CLOSED,
  closeMinute: 0,
});
const early = (month: number, day: number, closeMinute: number): CalendarEntryLike => ({
  dateKey: (month << 8) | day,
  kind: ENTRY_EARLY_CLOSE,
  closeMinute,
});

/**
 * `US_EQUITY_2026_2027` from state/registry.rs: Pyth's published `Equity.US.*` schedule,
 * captured 2026-09-20. This is the table `MarketCalendar::us_equity_2026_2027()` builds
 * and the one the program's tests resolve against. A deployed calendar account is the
 * authority once it exists; this copy is for evaluating the gate before one does.
 */
export const US_EQUITY_2026_2027: readonly CalendarEntryLike[] = Object.freeze([
  closed(9, 7),
  closed(11, 26),
  early(11, 27, 13 * 60),
  early(12, 24, 13 * 60),
  closed(12, 25),
  closed(1, 1),
  closed(1, 18),
  closed(2, 15),
  closed(3, 26),
  closed(5, 31),
  closed(6, 18),
  closed(7, 5),
]);

export const US_EQUITY_CALENDAR: CalendarLike = Object.freeze({
  regularOpenMinute: REGULAR_OPEN_MINUTE,
  regularCloseMinute: REGULAR_CLOSE_MINUTE,
  entries: US_EQUITY_2026_2027,
});

const trunc = (a: number, b: number): number => Math.trunc(a / b);
const divEuclid = (a: number, b: number): number => Math.floor(a / b);
const remEuclid = (a: number, b: number): number => ((a % b) + b) % b;

export function dateKey(month: number, day: number): number {
  return (month << 8) | day;
}

/** Howard Hinnant's `days_from_civil`. */
export function daysFromCivil(year: number, month: number, day: number): number {
  const y = year - (month <= 2 ? 1 : 0);
  const era = trunc(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400;
  const m = month;
  const doy = trunc(153 * (m > 2 ? m - 3 : m + 9) + 2, 5) + day - 1;
  const doe = yoe * 365 + trunc(yoe, 4) - trunc(yoe, 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/** `civil_from_days`: `[year, month, day]`. */
export function civilFromDays(days: number): [number, number, number] {
  const z = days + 719_468;
  const era = trunc(z >= 0 ? z : z - 146_096, 146_097);
  const doe = z - era * 146_097;
  const yoe = trunc(doe - trunc(doe, 1460) + trunc(doe, 36_524) - trunc(doe, 146_096), 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + trunc(yoe, 4) - trunc(yoe, 100));
  const mp = trunc(5 * doy + 2, 153);
  const d = doy - trunc(153 * mp + 2, 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [y + (m <= 2 ? 1 : 0), m, d];
}

/** 0 = Sunday. */
function weekdayOfDay(day: number): number {
  return remEuclid(day + 4, 7);
}

function nthWeekdayDay(year: number, month: number, weekday: number, n: number): number {
  const first = daysFromCivil(year, month, 1);
  const delta = (weekday + 7 - weekdayOfDay(first)) % 7;
  return first + delta + (n - 1) * 7;
}

/** EDT between the second Sunday of March 02:00 local and the first Sunday of November 02:00 local. */
export function easternOffsetSeconds(ts: number): number {
  const [year] = civilFromDays(divEuclid(ts, SECONDS_PER_DAY));
  const dstStart = nthWeekdayDay(year, 3, 0, 2) * SECONDS_PER_DAY + 7 * 3600;
  const dstEnd = nthWeekdayDay(year, 11, 0, 1) * SECONDS_PER_DAY + 6 * 3600;
  return ts >= dstStart && ts < dstEnd ? -4 * 3600 : -5 * 3600;
}

/** US Eastern civil time: `[year, month, day, minuteOfDay]`. */
export function civilFromUnix(ts: number): [number, number, number, number] {
  const local = ts + easternOffsetSeconds(ts);
  const [year, month, day] = civilFromDays(divEuclid(local, SECONDS_PER_DAY));
  return [year, month, day, trunc(remEuclid(local, SECONDS_PER_DAY), 60)];
}

type Exception = { kind: 'closed' } | { kind: 'early'; closeMinute: number };

function exception(cal: CalendarLike, key: number): Exception | undefined {
  const entry = cal.entries.find((e) => e.dateKey === key);
  if (!entry) return undefined;
  return entry.kind === ENTRY_EARLY_CLOSE ? { kind: 'early', closeMinute: entry.closeMinute } : { kind: 'closed' };
}

/** `resolve_session`. Open is inclusive, close exclusive: 16:00:00 ET is already shut. */
export function resolveSession(cal: CalendarLike, ts: number): Session {
  const local = ts + easternOffsetSeconds(ts);
  const days = divEuclid(local, SECONDS_PER_DAY);

  const weekday = weekdayOfDay(days);
  if (weekday === 0 || weekday === 6) return 'Closed';

  const [, month, day] = civilFromDays(days);
  const ex = exception(cal, dateKey(month, day));
  if (ex?.kind === 'closed') return 'Closed';
  const close = ex?.kind === 'early' ? ex.closeMinute : cal.regularCloseMinute;

  const minute = trunc(remEuclid(local, SECONDS_PER_DAY), 60);
  return minute >= cal.regularOpenMinute && minute < close ? 'Regular' : 'Closed';
}

function localDayAndMinute(ts: number): [number, number] {
  const local = ts + easternOffsetSeconds(ts);
  return [divEuclid(local, SECONDS_PER_DAY), trunc(remEuclid(local, SECONDS_PER_DAY), 60)];
}

function dayBounds(cal: CalendarLike, day: number): [number, number] | undefined {
  const weekday = weekdayOfDay(day);
  if (weekday === 0 || weekday === 6) return undefined;
  const [, month, date] = civilFromDays(day);
  const ex = exception(cal, dateKey(month, date));
  if (ex?.kind === 'closed') return undefined;
  const close = ex?.kind === 'early' ? ex.closeMinute : cal.regularCloseMinute;
  if (close <= cal.regularOpenMinute) return undefined;
  return [cal.regularOpenMinute, close];
}

/**
 * `open_minutes_between`: minutes of regular session between two instants, saturating
 * to `u32::MAX` past `MAX_SESSION_SCAN_DAYS`. This is the unit a settlement window is
 * measured in.
 */
export function openMinutesBetween(cal: CalendarLike, from: number, to: number): number {
  if (to <= from) return 0;
  const [firstDay, firstMinute] = localDayAndMinute(from);
  const [lastDay, lastMinute] = localDayAndMinute(to);
  if (lastDay - firstDay > MAX_SESSION_SCAN_DAYS) return U32_MAX;

  let total = 0;
  for (let day = firstDay; day <= lastDay; day++) {
    const bounds = dayBounds(cal, day);
    if (!bounds) continue;
    const [open, close] = bounds;
    const lo = day === firstDay ? Math.max(open, firstMinute) : open;
    const hi = day === lastDay ? Math.min(close, lastMinute) : close;
    if (hi > lo) total = Math.min(U32_MAX, total + (hi - lo));
  }
  return total;
}

/**
 * The next instant the session opens, scanning forward day by day. Not a program
 * function: it exists so a refusal can say when it will lift.
 */
export function nextOpen(cal: CalendarLike, ts: number, maxDays = MAX_SESSION_SCAN_DAYS): number | null {
  if (resolveSession(cal, ts) === 'Regular') return ts;
  const [today, minute] = localDayAndMinute(ts);
  for (let day = today; day <= today + maxDays; day++) {
    const bounds = dayBounds(cal, day);
    if (!bounds) continue;
    const [open] = bounds;
    if (day === today && minute >= open) continue;
    // Local midnight of `day` plus the opening minute, converted back to UTC with the
    // offset in force at that instant.
    const localOpen = day * SECONDS_PER_DAY + open * 60;
    const guess = localOpen + 5 * 3600;
    return localOpen - easternOffsetSeconds(guess);
  }
  return null;
}
