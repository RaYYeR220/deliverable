//! Unix timestamp to US Eastern civil time to trading session.
//!
//! Market hours are public, fixed and knowable in advance, so deciding that the
//! market is shut needs no oracle — it needs arithmetic. This makes the single
//! most frequent gate in the system trustless, and it is the one check that
//! still works when every price feed is lying.
//!
//! No chrono: this has to be small, allocation-free and identical off-chain.

use crate::constants::MAX_SESSION_SCAN_DAYS;
use crate::state::{Exception, MarketCalendar};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Session {
    Closed,
    Regular,
}

const SECONDS_PER_DAY: i64 = 86_400;

/// Days from 1970-01-01 to a civil date, by Howard Hinnant's `days_from_civil`.
pub fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let y = year as i64 - if month <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let m = month as i64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// The inverse: civil date from a day number. Returns `(year, month, day)`.
pub fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11], March-based
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    ((y + i64::from(m <= 2)) as i32, m, d)
}

/// Day number of the `n`th `weekday` of a month. `weekday` is 0 = Sunday.
fn nth_weekday_day(year: i32, month: u32, weekday: u32, n: u32) -> i64 {
    let first = days_from_civil(year, month, 1);
    let first_weekday = weekday_of_day(first);
    let delta = (weekday as i64 + 7 - first_weekday) % 7;
    first + delta + (n as i64 - 1) * 7
}

/// 0 = Sunday. 1970-01-01 was a Thursday.
fn weekday_of_day(day: i64) -> i64 {
    (day + 4).rem_euclid(7)
}

/// US Eastern is EST (-5) except between the second Sunday of March at 02:00
/// local and the first Sunday of November at 02:00 local, when it is EDT (-4).
///
/// The rule has been stable since 2007. If Congress ever abolishes the change,
/// this function is the one place that has to move.
pub fn eastern_offset_seconds(ts: i64) -> i64 {
    let (year, _, _) = civil_from_days(ts.div_euclid(SECONDS_PER_DAY));
    // 02:00 EST is 07:00Z; 02:00 EDT is 06:00Z.
    let dst_start = nth_weekday_day(year, 3, 0, 2) * SECONDS_PER_DAY + 7 * 3600;
    let dst_end = nth_weekday_day(year, 11, 0, 1) * SECONDS_PER_DAY + 6 * 3600;
    if ts >= dst_start && ts < dst_end {
        -4 * 3600
    } else {
        -5 * 3600
    }
}

/// US Eastern civil time: `(year, month, day, minute_of_day)`.
pub fn civil_from_unix(ts: i64) -> (i32, u32, u32, u32) {
    let local = ts + eastern_offset_seconds(ts);
    let (year, month, day) = civil_from_days(local.div_euclid(SECONDS_PER_DAY));
    let minute = (local.rem_euclid(SECONDS_PER_DAY) / 60) as u32;
    (year, month, day, minute)
}

/// Is the exchange open at `ts`?
///
/// Open is inclusive, close is exclusive: 16:00:00 ET is already shut, which is
/// what "the closing bell" means and what the schedule `0930-1600` encodes.
pub fn resolve_session(cal: &MarketCalendar, ts: i64) -> Session {
    let local = ts + eastern_offset_seconds(ts);
    let days = local.div_euclid(SECONDS_PER_DAY);

    let weekday = weekday_of_day(days);
    if weekday == 0 || weekday == 6 {
        return Session::Closed;
    }

    let (_, month, day) = civil_from_days(days);
    let close = match cal.exception(MarketCalendar::date_key(month, day)) {
        Some(Exception::Closed) => return Session::Closed,
        Some(Exception::EarlyClose(minute_of_close)) => minute_of_close,
        None => cal.regular_close_minute,
    };

    let minute = (local.rem_euclid(SECONDS_PER_DAY) / 60) as u16;
    if minute >= cal.regular_open_minute && minute < close {
        Session::Regular
    } else {
        Session::Closed
    }
}

/// The local day number and minute-of-day an instant falls on, in US Eastern.
fn local_day_and_minute(ts: i64) -> (i64, u16) {
    let local = ts + eastern_offset_seconds(ts);
    (
        local.div_euclid(SECONDS_PER_DAY),
        (local.rem_euclid(SECONDS_PER_DAY) / 60) as u16,
    )
}

/// The `[open, close)` minute window a local day trades in, or `None` if it
/// does not trade at all.
fn day_bounds(cal: &MarketCalendar, day: i64) -> Option<(u16, u16)> {
    let weekday = weekday_of_day(day);
    if weekday == 0 || weekday == 6 {
        return None;
    }
    let (_, month, date) = civil_from_days(day);
    let close = match cal.exception(MarketCalendar::date_key(month, date)) {
        Some(Exception::Closed) => return None,
        Some(Exception::EarlyClose(minute_of_close)) => minute_of_close,
        None => cal.regular_close_minute,
    };
    if close <= cal.regular_open_minute {
        return None;
    }
    Some((cal.regular_open_minute, close))
}

/// Minutes of regular session between two instants.
///
/// This is what a settlement window is measured in. Wall-clock would be the
/// wrong unit: a contract expiring on a Friday afternoon would spend its whole
/// window in the dark and settle against nothing, whereas an open-market clock
/// simply stops on Friday evening and resumes on Monday morning. It is also why
/// the window needs no keeper — nobody has to open or close anything, the
/// calendar already says how much market has gone past.
///
/// Walks at most [`MAX_SESSION_SCAN_DAYS`] days and then saturates, so the cost
/// of the call cannot be run up by leaving a series unsettled.
pub fn open_minutes_between(cal: &MarketCalendar, from: i64, to: i64) -> u32 {
    if to <= from {
        return 0;
    }
    let (first_day, first_minute) = local_day_and_minute(from);
    let (last_day, last_minute) = local_day_and_minute(to);
    if last_day - first_day > MAX_SESSION_SCAN_DAYS {
        return u32::MAX;
    }

    let mut total: u32 = 0;
    for day in first_day..=last_day {
        let Some((open, close)) = day_bounds(cal, day) else {
            continue;
        };
        let lo = if day == first_day {
            open.max(first_minute)
        } else {
            open
        };
        let hi = if day == last_day {
            close.min(last_minute)
        } else {
            close
        };
        if hi > lo {
            total = total.saturating_add((hi - lo) as u32);
        }
    }
    total
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cal() -> MarketCalendar {
        MarketCalendar::us_equity_2026_2027()
    }

    /// US Eastern civil time to unix. Two passes: guess the offset with EST,
    /// then correct with whatever offset actually applies at that instant.
    fn et(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        let local =
            days_from_civil(year, month, day) * SECONDS_PER_DAY + hour as i64 * 3600 + minute as i64 * 60;
        let guess = local + 5 * 3600;
        local - eastern_offset_seconds(guess)
    }

    #[test]
    fn civil_round_trips() {
        for (y, m, d) in [
            (1970, 1, 1),
            (2000, 2, 29),
            (2026, 3, 8),
            (2026, 11, 1),
            (2026, 12, 31),
            (2027, 1, 1),
        ] {
            let days = days_from_civil(y, m, d);
            assert_eq!(civil_from_days(days), (y, m, d), "{y}-{m}-{d}");
        }
        assert_eq!(days_from_civil(1970, 1, 1), 0);
    }

    #[test]
    fn dst_boundaries_are_correct() {
        // 2026-03-08 07:00Z is 02:00 EST -> becomes 03:00 EDT
        assert_eq!(eastern_offset_seconds(1_772_953_199), -5 * 3600);
        assert_eq!(eastern_offset_seconds(1_772_953_200), -4 * 3600);
        // 2026-11-01 06:00Z is 02:00 EDT -> becomes 01:00 EST
        assert_eq!(eastern_offset_seconds(1_793_512_799), -4 * 3600);
        assert_eq!(eastern_offset_seconds(1_793_512_800), -5 * 3600);
    }

    #[test]
    fn regular_session_opens_and_closes_on_the_minute() {
        // Monday 2026-09-21
        assert_eq!(resolve_session(&cal(), et(2026, 9, 21, 9, 29)), Session::Closed);
        assert_eq!(resolve_session(&cal(), et(2026, 9, 21, 9, 30)), Session::Regular);
        assert_eq!(resolve_session(&cal(), et(2026, 9, 21, 15, 59)), Session::Regular);
        assert_eq!(resolve_session(&cal(), et(2026, 9, 21, 16, 0)), Session::Closed);
    }

    #[test]
    fn weekends_are_closed() {
        assert_eq!(resolve_session(&cal(), et(2026, 9, 20, 12, 0)), Session::Closed); // Sunday
        assert_eq!(resolve_session(&cal(), et(2026, 9, 19, 12, 0)), Session::Closed); // Saturday
    }

    #[test]
    fn half_days_close_early() {
        // 2026-11-27, the day after Thanksgiving: closes 13:00 ET
        assert_eq!(resolve_session(&cal(), et(2026, 11, 27, 12, 59)), Session::Regular);
        assert_eq!(resolve_session(&cal(), et(2026, 11, 27, 13, 0)), Session::Closed);
        // 2026-12-24 likewise
        assert_eq!(resolve_session(&cal(), et(2026, 12, 24, 12, 59)), Session::Regular);
        assert_eq!(resolve_session(&cal(), et(2026, 12, 24, 13, 0)), Session::Closed);
        // and a naive "weekday between 09:30 and 16:00" check would have said open
        assert_eq!(resolve_session(&cal(), et(2026, 11, 27, 15, 0)), Session::Closed);
    }

    #[test]
    fn full_holidays_are_closed_all_day() {
        assert_eq!(resolve_session(&cal(), et(2026, 11, 26, 11, 0)), Session::Closed);
        assert_eq!(resolve_session(&cal(), et(2026, 12, 25, 11, 0)), Session::Closed);
        assert_eq!(resolve_session(&cal(), et(2027, 1, 1, 11, 0)), Session::Closed);
    }

    #[test]
    fn the_measurement_window_was_closed() {
        // The moment our headline measurement was taken: 2026-09-20 09:15Z.
        assert_eq!(resolve_session(&cal(), 1_789_895_700), Session::Closed);
    }

    #[test]
    fn session_survives_the_spring_forward() {
        // 2026-03-09 is the Monday after the clocks move. The open must still
        // be 09:30 local, an hour earlier in UTC than the Friday before.
        let friday_open = et(2026, 3, 6, 9, 30);
        let monday_open = et(2026, 3, 9, 9, 30);
        assert_eq!(resolve_session(&cal(), monday_open), Session::Regular);
        assert_eq!(resolve_session(&cal(), monday_open - 60), Session::Closed);
        assert_eq!(monday_open - friday_open, 3 * 86_400 - 3600);
    }

    #[test]
    fn open_minutes_accumulate_only_while_the_market_trades() {
        // Inside one session it is plain subtraction.
        assert_eq!(
            open_minutes_between(&cal(), et(2026, 9, 21, 10, 0), et(2026, 9, 21, 10, 30)),
            30
        );
        // Started before the open, so the clock starts at the bell.
        assert_eq!(
            open_minutes_between(&cal(), et(2026, 9, 21, 8, 0), et(2026, 9, 21, 10, 0)),
            30
        );
        // A whole regular session is 6.5 hours.
        assert_eq!(
            open_minutes_between(&cal(), et(2026, 9, 21, 0, 0), et(2026, 9, 22, 0, 0)),
            390
        );
    }

    #[test]
    fn a_window_opened_on_friday_afternoon_resumes_on_monday() {
        // This is the case that makes wall-clock the wrong unit: a contract
        // expiring five minutes before Friday's close has spent five of its
        // thirty minutes, and the remaining twenty-five are Monday's.
        let friday = et(2026, 9, 18, 15, 55);
        assert_eq!(open_minutes_between(&cal(), friday, et(2026, 9, 18, 16, 0)), 5);
        assert_eq!(
            open_minutes_between(&cal(), friday, et(2026, 9, 20, 12, 0)),
            5,
            "nothing accrues over the weekend"
        );
        assert_eq!(
            open_minutes_between(&cal(), friday, et(2026, 9, 21, 9, 50)),
            25
        );
    }

    #[test]
    fn open_minutes_skip_holidays_and_stop_early_on_a_half_day() {
        // 2026-11-26 Thanksgiving is shut; the 27th closes at 13:00.
        let from = et(2026, 11, 25, 15, 30);
        assert_eq!(open_minutes_between(&cal(), from, et(2026, 11, 26, 12, 0)), 30);
        assert_eq!(
            open_minutes_between(&cal(), from, et(2026, 11, 27, 15, 0)),
            30 + 210,
            "the half day contributes 09:30-13:00 and no more"
        );
    }

    #[test]
    fn the_accumulator_saturates_rather_than_scanning_forever() {
        let from = et(2026, 9, 21, 10, 0);
        assert_eq!(open_minutes_between(&cal(), from, from + 400 * 86_400), u32::MAX);
        assert_eq!(open_minutes_between(&cal(), from, from), 0);
        assert_eq!(open_minutes_between(&cal(), from, from - 1), 0);
    }

    #[test]
    fn civil_from_unix_reports_eastern_not_utc() {
        // 2026-09-21 13:30Z is 09:30 ET, the open.
        assert_eq!(civil_from_unix(et(2026, 9, 21, 9, 30)), (2026, 9, 21, 9 * 60 + 30));
        // 2026-12-25 01:00Z is still Christmas Eve in New York, and the half
        // day it falls on is what makes the date, not the UTC one, load-bearing.
        assert_eq!(civil_from_unix(1_798_160_400), (2026, 12, 24, 20 * 60));
    }
}
