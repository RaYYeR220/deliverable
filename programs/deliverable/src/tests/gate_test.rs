use std::sync::OnceLock;

use anchor_lang::prelude::*;

use crate::calendar::{days_from_civil, eastern_offset_seconds};
use crate::constants::{
    DEFAULT_MAX_CONF_BPS, DEFAULT_MAX_DIVERGENCE_BPS, DEFAULT_MAX_PRICE_AGE_SECS, SCALE,
};
use crate::error::{DeliverableError, RefusalCode};
use crate::gate::{assert_actionable, GateInputs, HaltState};
use crate::oracle::{Observation, OracleSource};
use crate::scaled_ui::MintMultiplier;
use crate::state::MarketCalendar;

use super::harness::{SCOPE_AAPLX_CHECKED, SCOPE_AAPLX_LAZER};

fn calendar() -> &'static MarketCalendar {
    static CAL: OnceLock<MarketCalendar> = OnceLock::new();
    CAL.get_or_init(MarketCalendar::us_equity_2026_2027)
}

/// US Eastern civil time to unix.
fn et(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    let local = days_from_civil(year, month, day) * 86_400 + hour as i64 * 3600 + minute as i64 * 60;
    local - eastern_offset_seconds(local + 5 * 3600)
}

/// Monday 2026-09-21, 10:00 ET — squarely inside a regular session.
fn open_monday() -> i64 {
    et(2026, 9, 21, 10, 0)
}

/// USD to the 1e-8 grid the equity feeds publish on.
fn price(usd: f64) -> i64 {
    (usd * 1e8).round() as i64
}

const PYTH_SOURCE: OracleSource = OracleSource::Pyth {
    feed_id: [1u8; 32],
    max_age: 3600,
};

/// The two Scope entries a security is normally bound to: the `Checked` one,
/// which resolves to the Chainlink-bounded number, and the `PythLazer` one.
const SCOPE_PRIMARY: OracleSource = OracleSource::Scope {
    index: SCOPE_AAPLX_CHECKED,
};
const SCOPE_SECONDARY: OracleSource = OracleSource::Scope {
    index: SCOPE_AAPLX_LAZER,
};

/// A security that is actionable in every respect. Each test breaks exactly
/// one thing, so a passing refusal test cannot be passing for another reason.
///
/// The default is the real shape of an xStock: two Scope entries, neither
/// publishing a confidence band, agreeing to well inside the divergence bound.
fn inputs() -> GateInputs<'static> {
    let now = open_monday();
    let p = price(336.7021);
    GateInputs {
        security: Pubkey::new_unique(),
        now,
        calendar: calendar(),
        halt: HaltState::default(),
        mint_paused: false,
        transfer_hook: None,
        multiplier: MintMultiplier {
            effective: SCALE,
            pending: None,
            epoch_key: 0,
        },
        primary_source: SCOPE_PRIMARY,
        primary: Observation {
            price: p,
            conf: 0,
            expo: -8,
            publish_ts: now - 5,
        },
        secondary: Some((
            SCOPE_SECONDARY,
            Observation {
                // 57 bps apart, which is what the two entries actually printed
                // in the captured account.
                price: price(334.7685),
                conf: 0,
                expo: -8,
                publish_ts: now - 5,
            },
        )),
        max_age: DEFAULT_MAX_PRICE_AGE_SECS,
        max_conf_bps: DEFAULT_MAX_CONF_BPS,
        max_divergence_bps: DEFAULT_MAX_DIVERGENCE_BPS,
    }
}

impl GateInputs<'_> {
    fn at(mut self, now: i64) -> Self {
        let age = self.now - self.primary.publish_ts;
        self.now = now;
        self.primary.publish_ts = now - age;
        if let Some((_, obs)) = self.secondary.as_mut() {
            obs.publish_ts = now - age;
        }
        self
    }

    fn with_observation(mut self, price: i64, publish_ts: i64) -> Self {
        self.primary.price = price;
        self.primary.publish_ts = publish_ts;
        self
    }

    /// Repoint the primary at a source that does publish a band, so the
    /// confidence check has something to bite on.
    fn with_pyth_primary(mut self, bps: u64) -> Self {
        self.primary_source = PYTH_SOURCE;
        self.primary.conf = (self.primary.price as u64) * bps / 10_000;
        self
    }

    fn with_pending_multiplier(mut self, effective_ts: i64) -> Self {
        self.multiplier.pending = Some((SCALE * 2, effective_ts));
        self
    }

    fn with_paused(mut self, paused: bool) -> Self {
        self.mint_paused = paused;
        self
    }

    fn with_transfer_hook(mut self, hook: Option<Pubkey>) -> Self {
        self.transfer_hook = hook;
        self
    }

    fn with_halt(mut self, halted: bool) -> Self {
        self.halt = HaltState {
            halted,
            since_ts: self.now - 120,
            attested_ts: self.now - 60,
            source: 1,
        };
        self
    }

    fn with_second_source(mut self, source: OracleSource, price: i64, conf_bps: u64) -> Self {
        self.secondary = Some((
            source,
            Observation {
                price,
                conf: (price as u64) * conf_bps / 10_000,
                expo: -8,
                publish_ts: self.primary.publish_ts,
            },
        ));
        self
    }

    /// Drop to the one source the security was registered with.
    fn single_declared(mut self) -> Self {
        self.secondary = None;
        self
    }
}

#[track_caller]
fn assert_refusal(result: Result<()>, code: RefusalCode) {
    let err = result.expect_err("expected a refusal, the gate allowed it");
    let want: u32 = DeliverableError::from(code).into();
    match err {
        Error::AnchorError(e) => assert_eq!(
            e.error_code_number, want,
            "refused with {} ({}), expected {code:?}",
            e.error_name, e.error_code_number
        ),
        other => panic!("expected an anchor error, got {other:?}"),
    }
}

#[test]
fn refuses_when_the_market_is_closed_even_if_the_price_looks_fresh() {
    // This is the whole thesis. Scope's timestamp advances every slot while the
    // market is shut; a naive freshness check passes. The calendar does not.
    let g = inputs()
        .at(1_789_895_700) // 2026-09-20 09:15Z, Sunday
        .with_observation(price(336.7021), 1_789_895_664); // 36s old
    assert_refusal(assert_actionable(&g), RefusalCode::MarketClosed);
}

#[test]
fn refuses_when_a_halt_is_attested() {
    let g = inputs().with_halt(true);
    assert_refusal(assert_actionable(&g), RefusalCode::Halted);
}

#[test]
fn refuses_on_a_stale_price_inside_an_open_session() {
    let g = inputs()
        .at(open_monday())
        .with_observation(price(336.0), open_monday() - 900);
    assert_refusal(assert_actionable(&g), RefusalCode::OracleStale);
}

#[test]
fn refuses_when_confidence_is_blown() {
    // Only a source that actually publishes a band can blow it.
    let g = inputs().at(open_monday()).with_pyth_primary(250); // threshold is 100
    assert_refusal(assert_actionable(&g), RefusalCode::ConfidenceBlown);
}

#[test]
fn a_wide_band_on_the_corroborating_source_refuses_too() {
    let g = inputs().at(open_monday()).with_second_source(
        OracleSource::Pyth {
            feed_id: [2u8; 32],
            max_age: 3600,
        },
        price(336.7),
        400,
    );
    assert_refusal(assert_actionable(&g), RefusalCode::ConfidenceBlown);
}

#[test]
fn refuses_while_a_multiplier_change_is_pending() {
    let g = inputs()
        .at(open_monday())
        .with_pending_multiplier(open_monday() + 600);
    assert_refusal(assert_actionable(&g), RefusalCode::MultiplierPending);
}

#[test]
fn refuses_when_the_issuer_pauses_the_mint() {
    let g = inputs().at(open_monday()).with_paused(true);
    assert_refusal(assert_actionable(&g), RefusalCode::IssuerPaused);
}

#[test]
fn refuses_when_a_transfer_hook_appears() {
    // Backed holds a live authority over the currently-empty transfer hook on
    // every xStock. If it is ever filled, arbitrary code runs on every transfer.
    let g = inputs()
        .at(open_monday())
        .with_transfer_hook(Some(Pubkey::new_unique()));
    assert_refusal(assert_actionable(&g), RefusalCode::HookAttached);
}

#[test]
fn refuses_when_two_sources_disagree() {
    let g = inputs()
        .at(open_monday())
        .with_second_source(SCOPE_SECONDARY, price(350.0), 0); // ~4% apart
    assert_refusal(assert_actionable(&g), RefusalCode::SourcesDisagree);
}

#[test]
fn refuses_a_security_bound_to_one_source() {
    // One number nothing can contradict is not a price. Registering a single
    // source is allowed and has to be spelled out; acting on it is not.
    let g = inputs().at(open_monday()).single_declared();
    assert_refusal(assert_actionable(&g), RefusalCode::SingleSource);
}

#[test]
fn a_single_source_that_does_publish_a_band_is_still_refused() {
    // Pyth's band bounds the number against itself, not against a second
    // opinion, and a feed that is wrong with confidence is the failure mode
    // this venue exists to refuse.
    let g = inputs()
        .at(open_monday())
        .with_pyth_primary(10)
        .single_declared();
    assert_refusal(assert_actionable(&g), RefusalCode::SingleSource);
}

#[test]
fn permits_a_fresh_price_in_an_open_session() {
    assert!(assert_actionable(&inputs().at(open_monday())).is_ok());
}

// --- beyond the eight conditions ---

#[test]
fn a_scheduled_dividend_weeks_out_does_not_close_the_venue() {
    // Only an imminent change refuses. A change scheduled weeks out is refused
    // only once it is inside the quiet period, so routine dividend steps do not
    // close the venue in the meantime.
    let g = inputs()
        .at(open_monday())
        .with_pending_multiplier(open_monday() + 14 * 86_400);
    assert!(assert_actionable(&g).is_ok());
}

#[test]
fn a_source_that_reports_no_confidence_is_not_treated_as_certain() {
    // Scope has no confidence field, and zero must not read as a zero-width
    // band that satisfies every bound. The corroboration requirement is what
    // answers the absence — not a fabricated `ConfidenceBlown`.
    assert!(!SCOPE_PRIMARY.reports_confidence());
    let g = inputs().at(open_monday());
    assert_eq!(g.primary.conf, 0);
    assert!(assert_actionable(&g).is_ok());
    assert_refusal(
        assert_actionable(&g.single_declared()),
        RefusalCode::SingleSource,
    );
}

#[test]
fn two_confidence_free_scope_entries_are_actionable_when_they_agree() {
    // This is the normal xStock configuration: Scope's `Checked` entry against
    // its `PythLazer` entry, neither publishing a band, 57 bps apart.
    let g = inputs().at(open_monday());
    assert!(matches!(
        g.secondary.map(|(source, _)| source),
        Some(OracleSource::Scope {
            index: SCOPE_AAPLX_LAZER
        })
    ));
    assert!(assert_actionable(&g).is_ok());
}

#[test]
fn a_stale_corroborating_source_refuses_like_a_stale_primary() {
    let mut g = inputs().at(open_monday());
    if let Some((_, obs)) = g.secondary.as_mut() {
        obs.publish_ts = open_monday() - 900;
    }
    assert_refusal(assert_actionable(&g), RefusalCode::OracleStale);
}

#[test]
fn the_calendar_is_checked_before_any_oracle() {
    // Everything is wrong at once. The refusal we publish is the one that needs
    // no oracle to establish, which is also the one that is true about 81% of the week.
    let g = inputs()
        .at(1_789_895_700)
        .with_halt(true)
        .with_paused(true)
        .with_transfer_hook(Some(Pubkey::new_unique()))
        .with_pyth_primary(9_000)
        .single_declared()
        .with_observation(price(336.7021), 0);
    assert_refusal(assert_actionable(&g), RefusalCode::MarketClosed);
}

#[test]
fn the_half_day_close_refuses_while_a_naive_clock_would_not() {
    // 2026-11-27 at 15:00 ET: a weekday, inside 09:30-16:00, and shut.
    let g = inputs().at(et(2026, 11, 27, 15, 0));
    assert_refusal(assert_actionable(&g), RefusalCode::MarketClosed);
    // an hour before the early close it is genuinely open
    assert!(assert_actionable(&inputs().at(et(2026, 11, 27, 12, 0))).is_ok());
}

#[test]
fn refusal_codes_are_the_integers_the_sdk_publishes() {
    // These appear in refused transactions we link to, so they are frozen.
    assert_eq!(RefusalCode::MarketClosed as u8, 1);
    assert_eq!(RefusalCode::Halted as u8, 2);
    assert_eq!(RefusalCode::OracleStale as u8, 3);
    assert_eq!(RefusalCode::ConfidenceBlown as u8, 4);
    assert_eq!(RefusalCode::MultiplierPending as u8, 5);
    assert_eq!(RefusalCode::IssuerPaused as u8, 6);
    assert_eq!(RefusalCode::HookAttached as u8, 7);
    assert_eq!(RefusalCode::SourcesDisagree as u8, 8);
    assert_eq!(RefusalCode::SingleSource as u8, 9);
}

/// `probe_security` derives the integer from the same enum the gate refuses
/// with, and stores it on the account for the UI to read.
#[test]
fn the_gate_reports_its_verdict_as_a_value_too() {
    use crate::gate::check_actionable;

    assert_eq!(check_actionable(&inputs().at(open_monday())).unwrap(), None);
    assert_eq!(
        check_actionable(&inputs().at(1_789_895_700)).unwrap(),
        Some(RefusalCode::MarketClosed)
    );
    assert_eq!(
        check_actionable(&inputs().at(open_monday()).single_declared()).unwrap(),
        Some(RefusalCode::SingleSource)
    );
}
