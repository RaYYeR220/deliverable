//! The adjustment invariant, replayed against corporate actions that happened.
//!
//! `strike x ui_size` is what the contract is worth in dollars. One formula
//! covers a +6 bp dividend and a ten-for-one split identically, which is why
//! the event never has to be classified — and why a venue that reads the
//! multiplier at settlement cannot miss one.

use crate::constants::SCALE;
use crate::fixed::f64_bits_to_fixed;
use crate::state::{OptionKind, OptionSeries};

use super::harness::{AAPLX_MULTIPLIER, AAPLX_NEW_MULTIPLIER};

fn fixed(v: f64) -> u128 {
    f64_bits_to_fixed(v.to_bits()).unwrap()
}

fn one() -> u128 {
    SCALE
}

/// USDC, six decimals, per UI share.
fn strike_usdc(dollars: f64) -> u64 {
    (dollars * 1e6).round() as u64
}

/// Raw units of an eight-decimal underlying.
fn raw(shares: f64) -> u64 {
    (shares * 1e8).round() as u64
}

fn series_at_multiplier(m0: u128, strike0: u64, contract_raw_size: u64) -> OptionSeries {
    build(m0, strike0, contract_raw_size, true)
}

/// The same contract written without adjustment, ignoring the mint: the
/// negative control the invariant tests are checked against.
fn series_with_adjustment_disabled(m0: u128, strike0: u64, contract_raw_size: u64) -> OptionSeries {
    build(m0, strike0, contract_raw_size, false)
}

fn build(
    m0: u128,
    strike0: u64,
    contract_raw_size: u64,
    adjust_on_corporate_action: bool,
) -> OptionSeries {
    OptionSeries {
        security: Default::default(),
        underlying_mint: Default::default(),
        quote_mint: Default::default(),
        option_mint: Default::default(),
        collateral_vault: Default::default(),
        premium_vault: Default::default(),
        quote_vault: Default::default(),
        creator: Default::default(),
        kind: OptionKind::Call,
        expiry_ts: 0,
        strike0,
        multiplier_at_mint: m0,
        contract_raw_size,
        settlement_window_minutes: 30,
        adjust_on_corporate_action,
        underlying_decimals: 8,
        quote_decimals: 6,
        bump: 0,
        contracts_written: 0,
        contracts_exercised: 0,
        quote_collected: 0,
        premium_claimed_total: 0,
        window_opened_ts: 0,
        acknowledged_multiplier: m0,
        contracts_assigned_total: 0,
        premium_per_contract_acc: 0,
        premium_credited_total: 0,
    }
}

/// `strike x ui_size` is invariant across any multiplier change.
#[track_caller]
fn assert_notional_invariant(s: &OptionSeries, m0: u128, m1: u128) {
    let n0 = s.current_strike(m0).unwrap() as u128 * s.current_ui_size(m0).unwrap();
    let n1 = s.current_strike(m1).unwrap() as u128 * s.current_ui_size(m1).unwrap();
    let tol = n0 / 1_000_000; // 1 ppm, for integer rounding only
    assert!(n0.abs_diff(n1) <= tol, "notional moved: {n0} -> {n1}");
}

#[test]
fn survives_the_netflix_ten_for_one() {
    // NFLXx multiplier 1.0 -> 10.0, effective 2025-11-16T23:55Z.
    let s = series_at_multiplier(one(), strike_usdc(500.0), raw(1.0));
    assert_notional_invariant(&s, one(), fixed(10.0));
    // a $500 strike on one share becomes a $50 strike on ten
    assert_eq!(s.current_strike(fixed(10.0)).unwrap(), strike_usdc(50.0));
    assert_eq!(
        s.current_ui_size(fixed(10.0)).unwrap(),
        raw(1.0) as u128 * 10
    );
    // and the holder still pays the same dollars for the same raw tokens
    assert_eq!(
        s.exercise_cost(fixed(10.0), 1).unwrap(),
        s.exercise_cost(one(), 1).unwrap()
    );
}

#[test]
fn survives_the_crowdstrike_four_for_one() {
    // CRWDx multiplier 1.0 -> 4.0, effective 2026-07-02T13:30Z.
    let s = series_at_multiplier(one(), strike_usdc(400.0), raw(1.0));
    assert_notional_invariant(&s, one(), fixed(4.0));
    assert_eq!(s.current_strike(fixed(4.0)).unwrap(), strike_usdc(100.0));
}

#[test]
fn survives_a_real_dividend_step() {
    // AAPLx 1.0026642075893797 -> 1.0032690125398187 (+6.0 bps), 2026-08-08.
    let m0 = fixed(AAPLX_MULTIPLIER);
    let m1 = fixed(AAPLX_NEW_MULTIPLIER);
    let s = series_at_multiplier(m0, strike_usdc(340.0), raw(1.0));
    assert_notional_invariant(&s, m0, m1);
    // the strike ticks down by the accrual, because the same contract now
    // covers fractionally more share
    assert!(s.current_strike(m1).unwrap() < strike_usdc(340.0));
    assert!(s.current_strike(m1).unwrap() > strike_usdc(339.5));
}

#[test]
fn survives_a_split_that_carries_accrued_dividends_with_it() {
    // KLACx is 10-for-1 plus accrual: 10.016833. Nothing classifies it.
    let s = series_at_multiplier(one(), strike_usdc(900.0), raw(1.0));
    assert_notional_invariant(&s, one(), fixed(10.016833));
}

/// NEGATIVE CONTROL. Without the adjustment the same split destroys the writer:
/// the holder pays $500 and walks away with ten shares. If this test ever stops
/// panicking, every invariant test above is vacuous.
#[test]
#[should_panic(expected = "notional moved")]
fn unadjusted_strike_breaks_on_a_split() {
    let s = series_with_adjustment_disabled(one(), strike_usdc(500.0), raw(1.0));
    assert_notional_invariant(&s, one(), fixed(10.0));
}

#[test]
fn the_unadjusted_series_is_wrong_by_exactly_the_split_factor() {
    // Naming the size of the error, so the negative control is not merely
    // "something differs".
    let s = series_with_adjustment_disabled(one(), strike_usdc(500.0), raw(1.0));
    let before = s.exercise_cost(one(), 1).unwrap();
    let after = s.exercise_cost(fixed(10.0), 1).unwrap();
    assert_eq!(after, before * 10);

    let adjusted = series_at_multiplier(one(), strike_usdc(500.0), raw(1.0));
    assert_eq!(adjusted.exercise_cost(fixed(10.0), 1).unwrap(), before);
}

#[test]
fn the_deliverable_is_raw_and_therefore_never_moves() {
    // The whole reason `contract_raw_size` is raw: a split changes what those
    // tokens are called, not how many of them the vault owes.
    let s = series_at_multiplier(one(), strike_usdc(500.0), raw(1.0));
    assert_eq!(s.delivery_raw(3).unwrap(), raw(3.0));
    assert_eq!(s.current_ui_size(one()).unwrap(), raw(1.0) as u128);
    assert_eq!(
        s.current_ui_size(fixed(10.0)).unwrap(),
        raw(10.0) as u128,
        "ten times the shares, same tokens"
    );
}

#[test]
fn exercise_cost_rounds_against_the_holder() {
    // A strike of one micro-dollar on an odd size: the holder must not take
    // delivery for less than the strike because integer division said so.
    let s = series_at_multiplier(one(), 1, 3);
    let cost = s.exercise_cost(one(), 1).unwrap();
    assert_eq!(cost, 1, "rounded up from 3e-8 of a micro-dollar");
}

#[test]
fn a_hundred_contracts_cost_a_hundred_times_one() {
    let m1 = fixed(AAPLX_NEW_MULTIPLIER);
    let s = series_at_multiplier(fixed(AAPLX_MULTIPLIER), strike_usdc(340.0), raw(1.0));
    assert_eq!(
        s.exercise_cost(m1, 100).unwrap(),
        s.exercise_cost(m1, 1).unwrap() * 100
    );
}
