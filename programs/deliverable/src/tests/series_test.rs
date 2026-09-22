//! Listing a series.
//!
//! A series is canonical — its PDA is the contract's identity — and its expiry
//! has to land somewhere a price can be defended. Both are checked here against
//! the calendar the program actually carries.

use anchor_lang::prelude::*;
use solana_signer::Signer as _;

use crate::fixed::f64_bits_to_fixed;
use crate::state::OptionKind;

use super::harness::{et, AAPLX_DECIMALS, AAPLX_MULTIPLIER, AAPLX_NEW_MULTIPLIER, USDC_DECIMALS};
use super::venue::{
    expiry_ts, ix, send, Venue, VenueConfig, CONTRACT_RAW_SIZE, SETTLEMENT_WINDOW_MINUTES, STRIKE0,
};

fn try_list(venue: &mut Venue, expiry: i64, kind: OptionKind) -> bool {
    let series = super::venue::series_pda(
        venue.underlying(),
        venue.quote(),
        expiry,
        STRIKE0,
        CONTRACT_RAW_SIZE,
        SETTLEMENT_WINDOW_MINUTES,
        kind,
        true,
    );
    let instruction = ix(
        crate::accounts::CreateSeries {
            creator: venue.authority.pubkey(),
            registry: venue.registry,
            security: venue.security,
            calendar: venue.calendar,
            underlying_mint: venue.underlying(),
            quote_mint: venue.quote(),
            series,
            option_mint: Pubkey::find_program_address(
                &[crate::constants::OPTION_MINT_SEED, series.as_ref()],
                &crate::ID,
            )
            .0,
            collateral_vault: Pubkey::find_program_address(
                &[crate::constants::VAULT_SEED, series.as_ref()],
                &crate::ID,
            )
            .0,
            premium_vault: Pubkey::find_program_address(
                &[crate::constants::PREMIUM_SEED, series.as_ref()],
                &crate::ID,
            )
            .0,
            quote_vault: Pubkey::find_program_address(
                &[crate::constants::QUOTE_SEED, series.as_ref()],
                &crate::ID,
            )
            .0,
            underlying_token_program: super::venue::token_2022_id(),
            quote_token_program: super::venue::token_legacy_id(),
            system_program: anchor_lang::system_program::ID,
        },
        crate::instruction::CreateSeries {
            expiry_ts: expiry,
            strike0: STRIKE0,
            kind,
            contract_raw_size: CONTRACT_RAW_SIZE,
            settlement_window_minutes: SETTLEMENT_WINDOW_MINUTES,
            adjust_on_corporate_action: true,
        },
    );
    let creator = venue.authority.insecure_clone();
    send(&mut venue.svm, &[instruction], &creator, &[]).is_ok()
}

#[test]
fn an_expiry_outside_a_regular_session_is_refused() {
    let mut venue = Venue::rail(VenueConfig::default());

    // Saturday.
    assert!(!try_list(&mut venue, et(2026, 9, 19, 12, 0), OptionKind::Call));
    // Christmas Day.
    assert!(!try_list(&mut venue, et(2026, 12, 25, 12, 0), OptionKind::Call));
    // 16:00 ET sharp: the close is exclusive, so the bell has already gone.
    assert!(!try_list(&mut venue, et(2026, 9, 18, 16, 0), OptionKind::Call));
    // 13:00 ET on the Christmas Eve half day, which a naive clock calls open.
    assert!(!try_list(&mut venue, et(2026, 12, 24, 13, 0), OptionKind::Call));
    // ...and an hour earlier on the same half day, which genuinely is.
    assert!(try_list(&mut venue, et(2026, 12, 24, 12, 0), OptionKind::Call));
}

#[test]
fn an_expiry_in_the_past_is_refused() {
    let mut venue = Venue::rail(VenueConfig::default());
    assert!(!try_list(&mut venue, et(2026, 9, 16, 12, 0), OptionKind::Call));
}

#[test]
fn cash_secured_puts_are_rejected_rather_than_half_built() {
    // The variant exists because the PDA seed and the SDK type are shaped
    // around it. Settlement for it is not built, and a venue that lists a
    // contract it cannot settle is worse than one that lists fewer.
    let mut venue = Venue::rail(VenueConfig::default());
    assert!(!try_list(&mut venue, expiry_ts(), OptionKind::Put));
    assert!(try_list(&mut venue, expiry_ts(), OptionKind::Call));
}

#[test]
fn a_series_is_canonical_and_cannot_be_listed_twice() {
    let mut venue = Venue::rail(VenueConfig::default());
    assert!(try_list(&mut venue, expiry_ts(), OptionKind::Call));
    assert!(
        !try_list(&mut venue, expiry_ts(), OptionKind::Call),
        "the PDA collides, which is the intent"
    );
}

#[test]
fn the_multiplier_is_captured_at_listing_and_never_moves() {
    let venue = Venue::listed(VenueConfig::default());
    let series = venue.series_state();

    assert_eq!(
        series.multiplier_at_mint,
        f64_bits_to_fixed(AAPLX_NEW_MULTIPLIER.to_bits()).unwrap()
    );
    assert_eq!(series.strike0, STRIKE0);
    assert_eq!(series.contract_raw_size, CONTRACT_RAW_SIZE);
    assert_eq!(series.underlying_decimals, AAPLX_DECIMALS);
    assert_eq!(series.quote_decimals, USDC_DECIMALS);
    assert_eq!(series.contracts_written, 0);

    // Half of the invariant lives in this number, so it is the one thing on the
    // account that no instruction writes twice.
    let before = series.multiplier_at_mint;
    let mut venue = venue;
    venue.sync_security().expect("sync failed");
    assert_eq!(venue.series_state().multiplier_at_mint, before);
}

#[test]
fn the_vaults_are_sized_for_the_extensions_the_mint_requires() {
    // xStock token accounts are 175 bytes, not 165: PausableAccount and
    // TransferHookAccount ride along. Anchor derives that from the mint, which
    // is why the program never has to know the number.
    let venue = Venue::listed(VenueConfig::default());
    let collateral = venue
        .svm
        .get_account(&super::venue::svm_key_of(venue.collateral_vault))
        .unwrap();
    assert_eq!(collateral.data.len(), 175);

    // USDC carries no extensions, so its vault is the plain 165.
    let quote = venue
        .svm
        .get_account(&super::venue::svm_key_of(venue.quote_vault))
        .unwrap();
    assert_eq!(quote.data.len(), 165);
}

#[test]
fn acknowledging_an_adjustment_publishes_the_re_cut() {
    // Listed before the real AAPLx dividend step landed, acknowledged after:
    // the strike on the wire ticks down by the accrual without anything about
    // the contract changing.
    let listing = et(2026, 8, 7, 11, 0);
    let mut venue = Venue::listed(VenueConfig {
        now: listing,
        ..VenueConfig::default()
    });
    let series = venue.series_state();
    assert_eq!(
        series.multiplier_at_mint,
        f64_bits_to_fixed(AAPLX_MULTIPLIER.to_bits()).unwrap(),
        "the old multiplier was still in force at listing"
    );
    let before = series.current_strike(series.multiplier_at_mint).unwrap();

    venue.at(et(2026, 9, 21, 10, 0));
    let instruction = ix(
        crate::accounts::AcknowledgeAdjustment {
            series: venue.series,
            underlying_mint: venue.underlying(),
        },
        crate::instruction::AcknowledgeAdjustment {},
    );
    let anyone = venue.holder.insecure_clone();
    send(&mut venue.svm, &[instruction], &anyone, &[])
        .expect("acknowledging must be permissionless");

    let series = venue.series_state();
    assert_eq!(
        series.acknowledged_multiplier,
        f64_bits_to_fixed(AAPLX_NEW_MULTIPLIER.to_bits()).unwrap()
    );
    let after = series.current_strike(series.acknowledged_multiplier).unwrap();
    assert!(after < before, "{after} should be below {before}");
    assert!(before - after < before / 1_000, "a dividend, not a split");
}
