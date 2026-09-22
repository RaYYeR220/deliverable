//! Writing a covered call against real collateral.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use solana_pubkey::Pubkey as SvmPubkey;

use crate::error::RefusalCode;
use crate::instructions::transfer_checked_instruction;

use super::harness::AAPLX_MINT;
use super::venue::{
    balance_of, refusal_code_in_logs, svm_key_of, Venue, VenueConfig, CONTRACT_RAW_SIZE, HERO_TS,
    WRITER_AAPLX,
};

#[test]
fn writing_deposits_raw_collateral_and_mints_one_option_per_contract() {
    let mut venue = Venue::listed(VenueConfig::default());
    venue.write(2).expect("write failed");

    // The vault holds raw units, not UI units. That is the whole reason a
    // split cannot move what is owed.
    assert_eq!(
        balance_of(&venue.svm, svm_key_of(venue.collateral_vault)),
        2 * CONTRACT_RAW_SIZE
    );
    assert_eq!(
        balance_of(&venue.svm, venue.writer_underlying),
        WRITER_AAPLX - 2 * CONTRACT_RAW_SIZE
    );
    assert_eq!(balance_of(&venue.svm, venue.writer_option), 2);

    let position = venue.position_state();
    assert_eq!(position.contracts, 2);
    assert_eq!(position.raw_collateral, 2 * CONTRACT_RAW_SIZE);
    assert!(!position.settled);
    assert_eq!(venue.series_state().contracts_written, 2);
}

#[test]
fn writing_twice_accumulates_into_one_position() {
    let mut venue = Venue::listed(VenueConfig::default());
    venue.write(1).expect("first write failed");
    venue.write(3).expect("second write failed");

    assert_eq!(venue.position_state().contracts, 4);
    assert_eq!(venue.series_state().contracts_written, 4);
    assert_eq!(balance_of(&venue.svm, venue.writer_option), 4);
}

#[test]
fn writing_is_refused_while_the_market_is_closed() {
    // Writing is a state-changing action against the security, so it takes the
    // same gate settlement does. A venue that refuses to settle at Friday's
    // close on a Sunday but lets you sell a new contract at that price has
    // only moved the problem.
    let mut venue = Venue::listed(VenueConfig::default());
    venue.at(HERO_TS);

    let failed = venue.write(1).expect_err("the market is shut");
    assert_eq!(
        refusal_code_in_logs(&failed.meta.logs),
        Some(RefusalCode::MarketClosed as u8)
    );
    assert_eq!(balance_of(&venue.svm, svm_key_of(venue.collateral_vault)), 0);
}

#[test]
fn writing_more_than_the_writer_holds_fails_in_the_token_program() {
    let mut venue = Venue::listed(VenueConfig::default());
    assert!(venue.write(6).is_err(), "only five raw shares are held");
    assert_eq!(venue.position_state().contracts, 0);
}

#[test]
fn writing_after_expiry_is_refused() {
    let mut venue = Venue::listed(VenueConfig::default());
    venue.at(super::venue::exercise_ts());
    assert!(venue.write(1).is_err(), "the series is past its expiry");
}

#[test]
fn a_zero_contract_write_is_refused() {
    let mut venue = Venue::listed(VenueConfig::default());
    assert!(venue.write(0).is_err());
}

/// The transfer carries whatever the caller passed through.
///
/// Backed holds a live authority over the currently-empty transfer hook on
/// every xStock; the day it is filled, every transfer needs the hook's extra
/// accounts or it fails. A test that only watched a transfer succeed would not
/// notice them being dropped, because SPL Token ignores accounts it did not
/// expect — so this asserts on the instruction the program builds.
#[test]
fn the_underlying_transfer_forwards_extra_accounts() {
    let token_program = Pubkey::new_from_array(super::harness::TOKEN_2022.to_bytes());
    let mint = Pubkey::new_from_array(AAPLX_MINT.to_bytes());
    let from = Pubkey::new_unique();
    let to = Pubkey::new_unique();
    let authority = Pubkey::new_unique();

    let hook_program = Pubkey::new_unique();
    let extra_meta_list = Pubkey::new_unique();
    let extras = [
        AccountMeta::new_readonly(hook_program, false),
        AccountMeta::new_readonly(extra_meta_list, false),
    ];

    let plain =
        transfer_checked_instruction(&token_program, &from, &mint, &to, &authority, &[], 1, 8)
            .unwrap();
    let forwarded = transfer_checked_instruction(
        &token_program, &from, &mint, &to, &authority, &extras, 1, 8,
    )
    .unwrap();

    assert_eq!(forwarded.accounts.len(), plain.accounts.len() + 2);
    assert_eq!(forwarded.data, plain.data, "same transfer, more accounts");
    assert_eq!(forwarded.accounts[plain.accounts.len()].pubkey, hook_program);
    assert_eq!(
        forwarded.accounts[plain.accounts.len() + 1].pubkey,
        extra_meta_list
    );
}

#[test]
fn a_write_still_succeeds_with_extra_accounts_attached() {
    // The hook is null today, so forwarding costs nothing on chain. This is the
    // half of the claim that has to be true in the VM rather than on paper.
    let mut venue = Venue::listed(VenueConfig::default());
    let mut instruction = venue.write_ix(1);
    instruction.accounts.push(AccountMeta::new_readonly(
        Pubkey::new_from_array(SvmPubkey::new_unique().to_bytes()),
        false,
    ));

    let writer = venue.writer.insecure_clone();
    super::venue::must_send(&mut venue.svm, &[instruction], &writer, &[]);
    assert_eq!(
        balance_of(&venue.svm, svm_key_of(venue.collateral_vault)),
        CONTRACT_RAW_SIZE
    );
}
