use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::oracle::{self, scope, OracleSource};

use super::harness::{
    account_info, PYTH_RECEIVER, PYTH_UPDATE_DATA, SCOPE_AAPLX_CHECKED, SCOPE_NVDAX_CHECKED, SCOPE_PRICES_DATA,
};

#[test]
fn decodes_the_feed_that_kamino_marks_against() {
    // disc(8) + oracle_mappings(32) + DatedPrice[512], 56 bytes each at 40 + i*56
    let aapl = scope::decode(SCOPE_PRICES_DATA, SCOPE_AAPLX_CHECKED).unwrap();
    let nvda = scope::decode(SCOPE_PRICES_DATA, SCOPE_NVDAX_CHECKED).unwrap();
    assert!((aapl.price as f64 * 10f64.powi(aapl.expo) - 336.70).abs() < 0.5);
    assert!((nvda.price as f64 * 10f64.powi(nvda.expo) - 222.35).abs() < 0.5);
    assert!(aapl.publish_ts > 1_789_000_000);
}

/// The two entries a security is actually bound to, in the captured account.
///
/// `Checked` is a `CappedFloored` composition bounded by Chainlink; `PythLazer`
/// is Pyth's own number. They are published side by side on one account, at
/// different exponents, and they do not agree — which is the point: a bound
/// they both satisfy is a bound two vendors agree on.
#[test]
fn the_paired_entries_are_two_prices_not_one() {
    use super::harness::{SCOPE_AAPLX_LAZER, SCOPE_NVDAX_LAZER};

    let checked = scope::decode(SCOPE_PRICES_DATA, SCOPE_AAPLX_CHECKED).unwrap();
    let lazer = scope::decode(SCOPE_PRICES_DATA, SCOPE_AAPLX_LAZER).unwrap();
    assert_ne!(checked.expo, lazer.expo, "different publication grids");
    assert_ne!(
        oracle::to_fixed(&checked).unwrap(),
        oracle::to_fixed(&lazer).unwrap()
    );

    // ...and close enough that the divergence bound is satisfied. 57 bps for
    // AAPLx, 64 bps for NVDAx, against a 150 bps default.
    let spread = crate::gate::divergence_bps(&checked, &lazer).unwrap();
    assert!((50..80).contains(&spread), "AAPLx spread was {spread} bps");

    let nvda_checked = scope::decode(SCOPE_PRICES_DATA, SCOPE_NVDAX_CHECKED).unwrap();
    let nvda_lazer = scope::decode(SCOPE_PRICES_DATA, SCOPE_NVDAX_LAZER).unwrap();
    let spread = crate::gate::divergence_bps(&nvda_checked, &nvda_lazer).unwrap();
    assert!((50..80).contains(&spread), "NVDAx spread was {spread} bps");
}

#[test]
fn rejects_an_index_that_is_out_of_range() {
    assert!(scope::decode(SCOPE_PRICES_DATA, 512).is_err());
}

#[test]
fn scope_carries_no_confidence_so_we_do_not_invent_one() {
    assert_eq!(scope::decode(SCOPE_PRICES_DATA, SCOPE_AAPLX_CHECKED).unwrap().conf, 0);
    assert!(!OracleSource::Scope { index: SCOPE_AAPLX_CHECKED }.reports_confidence());
}

/// The headline measurement, re-derived from the account itself: the
/// timestamp is seconds old while the price has not moved since Friday's
/// close 38 hours earlier (20:00 UTC Friday to the capture's 10:14:54 UTC
/// Sunday stamp). Every freshness check a program can perform passes.
#[test]
fn scope_timestamp_is_fresh_while_the_market_has_been_shut_for_days() {
    let aapl = scope::decode(SCOPE_PRICES_DATA, SCOPE_AAPLX_CHECKED).unwrap();
    let captured_at = 1_789_899_294; // the slot's unix_timestamp, 2026-09-20
    assert!((captured_at - aapl.publish_ts).abs() < 60);

    let cal = crate::state::MarketCalendar::us_equity_2026_2027();
    assert_eq!(
        crate::calendar::resolve_session(&cal, aapl.publish_ts),
        crate::calendar::Session::Closed
    );
}

#[test]
fn an_unmapped_scope_slot_is_not_a_price() {
    // 101 of the 512 slots in this account have never been mapped and read
    // back as zeroes. A zero price is an empty slot, not a free asset.
    assert!(scope::decode(SCOPE_PRICES_DATA, 0).is_err());
    assert!(scope::decode(SCOPE_PRICES_DATA, 364).is_err());
}

#[test]
fn observe_refuses_a_scope_account_owned_by_someone_else() {
    let key = Pubkey::new_unique();
    let owner = Pubkey::new_unique();
    let mut lamports = 1u64;
    let mut data = SCOPE_PRICES_DATA.to_vec();
    let info = account_info(&key, &owner, &mut lamports, &mut data);

    let source = OracleSource::Scope { index: SCOPE_AAPLX_CHECKED };
    assert!(oracle::observe(&source, &info, 1_789_899_294).is_err());
}

#[test]
fn observe_reads_scope_through_the_source_enum() {
    let key = Pubkey::new_from_array(crate::constants::SCOPE_PRICES.to_bytes());
    let owner = crate::constants::SCOPE_PROGRAM;
    let mut lamports = 200_726_443u64;
    let mut data = SCOPE_PRICES_DATA.to_vec();
    let info = account_info(&key, &owner, &mut lamports, &mut data);

    let source = OracleSource::Scope { index: SCOPE_AAPLX_CHECKED };
    let direct = scope::decode(SCOPE_PRICES_DATA, SCOPE_AAPLX_CHECKED).unwrap();
    assert_eq!(oracle::observe(&source, &info, 1_789_899_294).unwrap(), direct);
}

fn pyth_feed_id() -> [u8; 32] {
    let parsed = PriceUpdateV2::deserialize(&mut &PYTH_UPDATE_DATA[8..]).unwrap();
    parsed.price_message.feed_id
}

#[test]
fn observe_reads_a_verified_pyth_update_and_keeps_its_confidence() {
    let parsed = PriceUpdateV2::deserialize(&mut &PYTH_UPDATE_DATA[8..]).unwrap();
    let now = parsed.price_message.publish_time + 5;

    let key = Pubkey::new_unique();
    let owner = PYTH_RECEIVER.to_bytes().into();
    let mut lamports = 1_825_031u64;
    let mut data = PYTH_UPDATE_DATA.to_vec();
    let info = account_info(&key, &owner, &mut lamports, &mut data);

    let source = OracleSource::Pyth {
        feed_id: pyth_feed_id(),
        max_age: 60,
    };
    let obs = oracle::observe(&source, &info, now).unwrap();

    assert_eq!(obs.price, parsed.price_message.price);
    assert_eq!(obs.expo, parsed.price_message.exponent);
    assert_eq!(obs.publish_ts, parsed.price_message.publish_time);
    // Unlike Scope, Pyth does publish a band, and this one is non-zero.
    assert_eq!(obs.conf, parsed.price_message.conf);
    assert!(obs.conf > 0);
    assert!(source.reports_confidence());
}

#[test]
fn observe_refuses_a_pyth_update_for_a_different_feed() {
    let parsed = PriceUpdateV2::deserialize(&mut &PYTH_UPDATE_DATA[8..]).unwrap();
    let key = Pubkey::new_unique();
    let owner = PYTH_RECEIVER.to_bytes().into();
    let mut lamports = 1_825_031u64;
    let mut data = PYTH_UPDATE_DATA.to_vec();
    let info = account_info(&key, &owner, &mut lamports, &mut data);

    let source = OracleSource::Pyth {
        feed_id: [7u8; 32],
        max_age: 60,
    };
    assert!(oracle::observe(&source, &info, parsed.price_message.publish_time + 5).is_err());
}

#[test]
fn observe_refuses_a_pyth_update_past_its_outer_age_bound() {
    let parsed = PriceUpdateV2::deserialize(&mut &PYTH_UPDATE_DATA[8..]).unwrap();
    let key = Pubkey::new_unique();
    let owner = PYTH_RECEIVER.to_bytes().into();
    let mut lamports = 1_825_031u64;
    let mut data = PYTH_UPDATE_DATA.to_vec();
    let info = account_info(&key, &owner, &mut lamports, &mut data);

    let source = OracleSource::Pyth {
        feed_id: pyth_feed_id(),
        max_age: 60,
    };
    let way_later = parsed.price_message.publish_time + 3600;
    assert!(oracle::observe(&source, &info, way_later).is_err());
}

#[test]
fn prices_with_different_exponents_normalise_to_the_same_scale() {
    // Scope publishes AAPLx at exp 15; Pyth equity feeds publish at exp -8.
    // The gate compares them, so the normalisation has to survive the gap.
    let scope_obs = scope::decode(SCOPE_PRICES_DATA, SCOPE_AAPLX_CHECKED).unwrap();
    let as_pyth = crate::oracle::Observation {
        price: 33_670_209_695,
        conf: 12_000_000,
        expo: -8,
        publish_ts: scope_obs.publish_ts,
    };
    let a = oracle::to_fixed(&scope_obs).unwrap();
    let b = oracle::to_fixed(&as_pyth).unwrap();
    assert!(a.abs_diff(b) < a / 1_000_000, "{a} vs {b}");
}
