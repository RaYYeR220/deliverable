//! Exercise, settlement, and the refusal the whole thing is built around.

use anchor_lang::prelude::*;
use solana_signer::Signer as _;

use crate::error::RefusalCode;
use crate::fixed::f64_bits_to_fixed;

use super::harness::{et, AAPLX_MULTIPLIER};
use super::venue::{
    balance_of, exercise_ts, ix, refusal_code_in_logs, send, settled_ts, svm_key_of, Venue,
    VenueConfig, CONTRACT_RAW_SIZE, HERO_TS, HOLDER_USDC, STRIKE0, WRITER_AAPLX,
};

/// What one AAPLx contract costs to exercise at the multiplier in force today:
/// a $340 strike on 1.00326901 shares.
const EXERCISE_COST: u64 = 341_111_464;

/// The end-to-end covered call, from a real mint to a real delivery.
///
/// Registers the security from the live AAPLx mint, lists a series, writes a
/// contract against real collateral, is refused on the Sunday, and then settles
/// physically inside Monday's session.
#[test]
fn the_covered_call_survives_the_weekend_and_settles_in_the_share() {
    let mut venue = Venue::written(VenueConfig::default(), 1);

    assert_eq!(
        balance_of(&venue.svm, svm_key_of(venue.collateral_vault)),
        CONTRACT_RAW_SIZE
    );
    assert_eq!(balance_of(&venue.svm, venue.writer_option), 1);

    // The option changes hands. On mainnet this is the Meteora pool; here it is
    // the transfer the pool would have made.
    venue.hand_option_to_holder(1);

    // --- Sunday. Scope's timestamp is seconds old and its price is 37 hours
    // stale. Every freshness check a program can perform passes. ---
    venue.at(HERO_TS);
    let failed = venue.exercise(1).expect_err("the market is shut");
    assert_eq!(
        refusal_code_in_logs(&failed.meta.logs),
        Some(RefusalCode::MarketClosed as u8),
        "{:?}",
        failed.meta.logs
    );
    assert_eq!(balance_of(&venue.svm, venue.holder_underlying), 0);
    assert_eq!(balance_of(&venue.svm, venue.holder_quote), HOLDER_USDC);

    // --- Monday, twenty open-market minutes into a window that opened on
    // Friday afternoon. ---
    venue.at(exercise_ts());
    venue.exercise(1).expect("exercise failed");

    assert_eq!(
        balance_of(&venue.svm, venue.holder_underlying),
        CONTRACT_RAW_SIZE,
        "physical delivery of the real tokenized share"
    );
    assert_eq!(
        balance_of(&venue.svm, venue.holder_quote),
        HOLDER_USDC - EXERCISE_COST
    );
    assert_eq!(
        balance_of(&venue.svm, svm_key_of(venue.quote_vault)),
        EXERCISE_COST
    );
    assert_eq!(balance_of(&venue.svm, venue.holder_option), 0, "burned");
    assert_eq!(balance_of(&venue.svm, svm_key_of(venue.collateral_vault)), 0);

    let series = venue.series_state();
    assert_eq!(series.contracts_exercised, 1);
    assert_eq!(series.quote_collected, EXERCISE_COST);
    assert_eq!(series.window_opened_ts, exercise_ts());

    // --- The window runs out, and the writer collects the strike. ---
    venue.at(settled_ts());
    venue.settle_expired().expect("settle failed");

    assert_eq!(balance_of(&venue.svm, venue.writer_quote), EXERCISE_COST);
    assert_eq!(
        balance_of(&venue.svm, venue.writer_underlying),
        WRITER_AAPLX - CONTRACT_RAW_SIZE,
        "fully assigned, so nothing comes back"
    );
    assert!(venue.position_state().settled);
}

#[test]
fn the_settlement_window_reopens_in_the_next_session_rather_than_expiring() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.hand_option_to_holder(1);

    // Five of the thirty minutes are Friday's.
    venue.at(et(2026, 9, 18, 15, 55));
    assert_eq!(venue.series_state().phase(&venue.calendar_state(), et(2026, 9, 18, 15, 55)),
        crate::state::SeriesPhase::Settling);

    // Nothing accrues over the weekend, and Sunday refuses on the calendar
    // rather than on the window.
    venue.at(HERO_TS);
    let failed = venue.exercise(1).expect_err("shut");
    assert_eq!(
        refusal_code_in_logs(&failed.meta.logs),
        Some(RefusalCode::MarketClosed as u8)
    );

    // Monday morning the window is still open, with twenty minutes left.
    venue.at(exercise_ts());
    venue.exercise(1).expect("the window should still be open");
}

#[test]
fn exercising_after_the_window_has_run_out_is_refused() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.hand_option_to_holder(1);
    venue.at(settled_ts());
    let failed = venue.exercise(1).expect_err("the window is spent");
    assert!(
        failed
            .meta
            .logs
            .iter()
            .any(|l| l.contains("SettlementWindowClosed")),
        "{:?}",
        failed.meta.logs
    );
}

#[test]
fn exercising_before_expiry_is_refused_because_the_style_is_european() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.hand_option_to_holder(1);
    let failed = venue.exercise(1).expect_err("not expired yet");
    assert!(
        failed
            .meta
            .logs
            .iter()
            .any(|l| l.contains("SettlementWindowNotOpen")),
        "{:?}",
        failed.meta.logs
    );
}

#[test]
fn exercising_across_a_corporate_action_pays_the_adjusted_strike() {
    // Listed on 2026-08-07, before the real AAPLx dividend step landed at
    // 2026-08-08T00:30Z; exercised after. The strike re-cuts itself off the
    // mint, with no adjustment transaction in between.
    let mut venue = Venue::written(
        VenueConfig {
            now: et(2026, 8, 7, 11, 0),
            ..VenueConfig::default()
        },
        1,
    );
    venue.hand_option_to_holder(1);

    let m0 = f64_bits_to_fixed(AAPLX_MULTIPLIER.to_bits()).unwrap();
    assert_eq!(venue.series_state().multiplier_at_mint, m0);

    venue.at(exercise_ts());
    venue.exercise(1).expect("exercise failed");

    let paid = HOLDER_USDC - balance_of(&venue.svm, venue.holder_quote);

    // What the same contract would have cost before the accrual: the notional
    // is what has to be invariant, not the strike.
    let ui_size_then = (CONTRACT_RAW_SIZE as u128 * m0) / crate::constants::SCALE;
    let cost_then = (STRIKE0 as u128 * ui_size_then).div_ceil(100_000_000) as u64;
    assert!(
        paid.abs_diff(cost_then) <= cost_then / 1_000_000,
        "notional moved: {paid} vs {cost_then}"
    );

    // ...and strictly less than an unadjusted venue would have charged for the
    // same delivery, because the share each token represents grew.
    assert!(paid < EXERCISE_COST, "{paid} should be below {EXERCISE_COST}");
    assert_eq!(
        balance_of(&venue.svm, venue.holder_underlying),
        CONTRACT_RAW_SIZE
    );
}

#[test]
fn unexercised_collateral_comes_back_to_the_writer_in_raw_units() {
    let mut venue = Venue::written(VenueConfig::default(), 2);
    venue.at(settled_ts());
    venue.settle_expired().expect("settle failed");

    assert_eq!(balance_of(&venue.svm, venue.writer_underlying), WRITER_AAPLX);
    assert_eq!(balance_of(&venue.svm, svm_key_of(venue.collateral_vault)), 0);
    assert_eq!(balance_of(&venue.svm, venue.writer_quote), 0);
    assert!(venue.position_state().settled);
}

#[test]
fn a_partially_exercised_series_splits_the_writer_between_shares_and_dollars() {
    let mut venue = Venue::written(VenueConfig::default(), 2);
    venue.hand_option_to_holder(1); // one of two contracts changes hands

    venue.at(exercise_ts());
    venue.exercise(1).expect("exercise failed");

    venue.at(settled_ts());
    venue.settle_expired().expect("settle failed");

    assert_eq!(
        balance_of(&venue.svm, venue.writer_underlying),
        WRITER_AAPLX - CONTRACT_RAW_SIZE,
        "one contract delivered, one returned"
    );
    assert_eq!(balance_of(&venue.svm, venue.writer_quote), EXERCISE_COST);
}

#[test]
fn settling_before_the_window_closes_is_refused() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.at(exercise_ts());
    assert!(
        venue.settle_expired().is_err(),
        "the holder can still exercise"
    );
}

#[test]
fn settling_twice_is_refused() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.at(settled_ts());
    venue.settle_expired().expect("settle failed");
    assert!(venue.settle_expired().is_err());
}

#[test]
fn premium_is_paid_in_the_share_and_claimable_once() {
    // Premium arrives as a plain transfer, which is what a Meteora fee claim on
    // a stock-quoted pool looks like from here: a covered call written against
    // AAPLx accumulates AAPLx.
    let mut venue = Venue::written(VenueConfig::default(), 1);
    let premium = 7_500_000u64;
    venue.deposit_premium(premium);

    let before = balance_of(&venue.svm, venue.writer_underlying);
    venue.claim_premium().expect("claim failed");
    assert_eq!(
        balance_of(&venue.svm, venue.writer_underlying),
        before + premium
    );
    assert_eq!(venue.position_state().premium_claimed, premium);
    assert_eq!(venue.series_state().premium_claimed_total, premium);

    assert!(
        venue.claim_premium().is_err(),
        "nothing left, so nothing to claim"
    );

    // A second deposit is claimable again: the vault balance is the total, so
    // premium can keep arriving without an instruction to announce it.
    venue.deposit_premium(premium);
    venue.claim_premium().expect("second claim failed");
    assert_eq!(
        balance_of(&venue.svm, venue.writer_underlying),
        before + 2 * premium
    );
}

#[test]
fn premium_cannot_be_claimed_by_someone_who_did_not_write() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.deposit_premium(1_000_000);

    let instruction = ix(
        crate::accounts::ClaimPremium {
            writer: super::venue::anchor_key(venue.holder.pubkey()),
            series: venue.series,
            position: venue.position,
            underlying_mint: venue.underlying(),
            premium_vault: venue.premium_vault,
            writer_underlying: super::venue::anchor_key(venue.holder_underlying),
            underlying_token_program: super::venue::token_2022_id(),
        },
        crate::instruction::ClaimPremium {},
    );
    let holder = venue.holder.insecure_clone();
    assert!(send(&mut venue.svm, &[instruction], &holder, &[]).is_err());
}
