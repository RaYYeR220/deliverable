use anchor_lang::prelude::*;

use crate::constants::{REGULAR_CLOSE_MINUTE, REGULAR_OPEN_MINUTE};

/// Program-wide configuration. One per deployment.
#[account]
#[derive(InitSpace)]
pub struct Registry {
    /// May create calendars and register securities. It may **not** repoint a
    /// security's oracle sources: `security.sources` is written once at
    /// registration and there is no instruction to change it.
    pub authority: Pubkey,
    /// The only key whose halt attestations the program accepts.
    pub attestor: Pubkey,
    /// Kill switch. Set it and every gated action refuses — which is every
    /// value-moving instruction except `settle_expired`, deliberately, so that
    /// pausing the venue cannot strand a writer's collateral.
    pub paused: bool,
    pub bump: u8,
}

/// A single deviation from the regular weekday session.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub struct CalendarEntry {
    /// `(year << 16) | (month << 8) | day`.
    ///
    /// The year is load-bearing. Pyth publishes its schedule as bare MMDD, and
    /// keying on that meant every entry fired in every subsequent year until
    /// somebody rewrote the table: Labor Day 2026 is 7 September, so in 2027 an
    /// ordinary Tuesday read as closed — and Labor Day 2027 is the 6th, which
    /// was not in the table at all, so the program reported a regular session
    /// on a day the exchange was shut. The second direction is the dangerous
    /// one: the session gate passes and the refusal falls through to a
    /// staleness check that a weekend-fresh timestamp satisfies.
    pub date_key: u32,
    /// [`ENTRY_CLOSED`] or [`ENTRY_EARLY_CLOSE`].
    pub kind: u8,
    /// Minutes past local midnight, meaningful only for an early close.
    pub close_minute: u16,
}

pub const ENTRY_CLOSED: u8 = 0;
pub const ENTRY_EARLY_CLOSE: u8 = 1;

/// A calendar entry resolved into something the session logic can use.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Exception {
    Closed,
    EarlyClose(u16),
}

/// Headroom for a year of US holidays and half-days with room to append the
/// next year's before the current one is retired.
pub const MAX_CALENDAR_ENTRIES: usize = 64;

/// The exchange schedule, committed on-chain.
///
/// We commit the price publisher's own published schedule rather than our own,
/// so the gate cannot disagree with the feed it guards.
#[account]
#[derive(InitSpace)]
pub struct MarketCalendar {
    pub authority: Pubkey,
    /// Identifies the calendar in its PDA seed; `0` is US equities.
    pub id: u16,
    /// Bumped whenever entries change, so an indexer can tell which schedule a
    /// past refusal was decided under.
    pub version: u16,
    pub regular_open_minute: u16,
    pub regular_close_minute: u16,
    pub bump: u8,
    #[max_len(MAX_CALENDAR_ENTRIES)]
    pub entries: Vec<CalendarEntry>,
}

impl MarketCalendar {
    pub fn date_key(year: i32, month: u32, day: u32) -> u32 {
        ((year as u32) << 16) | (month << 8) | day
    }

    /// Linear scan: the table is at most 64 entries and keeping it sorted would
    /// be an invariant the append instruction has to defend for no gain.
    pub fn exception(&self, key: u32) -> Option<Exception> {
        self.entries.iter().find(|e| e.date_key == key).map(|e| {
            if e.kind == ENTRY_EARLY_CLOSE {
                Exception::EarlyClose(e.close_minute)
            } else {
                Exception::Closed
            }
        })
    }

    /// The committed US equity schedule, in memory. Tests resolve sessions
    /// against exactly the table `init_calendar` writes on-chain.
    pub fn us_equity_2026_2027() -> Self {
        MarketCalendar {
            authority: Pubkey::default(),
            id: 0,
            version: 1,
            regular_open_minute: REGULAR_OPEN_MINUTE,
            regular_close_minute: REGULAR_CLOSE_MINUTE,
            bump: 0,
            entries: US_EQUITY_2026_2027.to_vec(),
        }
    }
}

/// Pyth's published schedule for `Equity.US.*`, captured 2026-09-20 from
/// `GET https://hermes.pyth.network/v2/price_feeds?asset_type=equity`:
///
/// ```text
/// America/New_York;0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C;
/// 0907/C,1126/C,1127/0930-1300,1224/0930-1300,1225/C,0101/C,0118/C,0215/C,
/// 0326/C,0531/C,0618/C,0705/C
/// ```
/// Each entry now carries the year Pyth published it for. The final entry is
/// not Pyth's — Labor Day 2027 falls outside the twelve months the capture
/// covers — and is here because without it the first Monday of September 2027
/// reads as a regular session, which is the failure direction that lets a
/// contract settle on a day the exchange is shut.
pub const US_EQUITY_2026_2027: [CalendarEntry; 13] = [
    closed(2026, 9, 7),            // Labor Day 2026
    closed(2026, 11, 26),          // Thanksgiving
    early(2026, 11, 27, 13 * 60),  // day after Thanksgiving
    early(2026, 12, 24, 13 * 60),  // Christmas Eve
    closed(2026, 12, 25),          // Christmas
    closed(2027, 1, 1),            // New Year's Day 2027
    closed(2027, 1, 18),           // Martin Luther King Jr. Day
    closed(2027, 2, 15),           // Washington's Birthday
    closed(2027, 3, 26),           // Good Friday
    closed(2027, 5, 31),           // Memorial Day
    closed(2027, 6, 18),           // Juneteenth, observed
    closed(2027, 7, 5),            // Independence Day, observed
    closed(2027, 9, 6),            // Labor Day 2027
];

const fn closed(year: u32, month: u32, day: u32) -> CalendarEntry {
    CalendarEntry {
        date_key: (year << 16) | (month << 8) | day,
        kind: ENTRY_CLOSED,
        close_minute: 0,
    }
}

const fn early(year: u32, month: u32, day: u32, close_minute: u16) -> CalendarEntry {
    CalendarEntry {
        date_key: (year << 16) | (month << 8) | day,
        kind: ENTRY_EARLY_CLOSE,
        close_minute,
    }
}
