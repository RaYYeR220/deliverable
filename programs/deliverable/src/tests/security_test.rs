//! The rail, exercised through the compiled program.
//!
//! `sync_security` is the first thing in this build to read the multiplier off
//! a real `InterfaceAccount<Mint>` inside a transaction rather than from a byte
//! slice in a unit test, which is the difference between the extension layout
//! being right on paper and being right on chain.

use anchor_lang::prelude::*;
use solana_pubkey::Pubkey as SvmPubkey;
use solana_signer::Signer as _;

use crate::constants::{REGISTRY_SEED, SCOPE_PRICES, SECURITY_SEED};
use crate::error::RefusalCode;
use crate::fixed::f64_bits_to_fixed;
use crate::oracle::{scope, OracleBinding, OracleSource};

use super::harness::{
    usdc_mint_account, AAPLX_DECIMALS, AAPLX_NEW_MULTIPLIER, SCOPE_AAPLX_CHECKED, SCOPE_AAPLX_LAZER,
    SCOPE_PRICES_DATA, USDC_MINT,
};
use super::venue::{ix, refusal_code_in_logs, send, symbol, Venue, VenueConfig, HERO_TS};

#[test]
fn sync_security_records_what_the_mint_and_the_oracle_actually_say() {
    let mut venue = Venue::rail(VenueConfig::default());
    venue.sync_security().expect("sync failed");

    let state = venue.security_state();

    // The multiplier came off the real Token-2022 extension, through
    // `InterfaceAccount<Mint>`, inside the transaction.
    assert_eq!(
        state.observed_multiplier,
        f64_bits_to_fixed(AAPLX_NEW_MULTIPLIER.to_bits()).unwrap()
    );
    assert_eq!(state.pending_multiplier, 0, "the step already landed");
    assert_eq!(state.decimals, AAPLX_DECIMALS);
    assert!(!state.mint_paused);
    assert_eq!(
        state.transfer_hook, None,
        "the hook is initialised but null on every xStock today"
    );

    // ...and the price came off the real Scope account, at the index Kamino's
    // own xStocks reserve marks against.
    let expected = scope::decode(SCOPE_PRICES_DATA, SCOPE_AAPLX_CHECKED).unwrap();
    assert_eq!(state.primary.price, expected.price);
    assert_eq!(state.primary.expo, expected.expo);
    assert_eq!(state.primary.conf, 0, "Scope publishes no band");

    let second = scope::decode(SCOPE_PRICES_DATA, SCOPE_AAPLX_LAZER).unwrap();
    assert_eq!(state.secondary.unwrap().price, second.price);
    assert_ne!(
        state.secondary.unwrap().price, state.primary.price,
        "two entries, two numbers"
    );
    assert_eq!(state.synced_ts, venue.config.now);
    assert_eq!(state.symbol_str(), "AAPLx");
}

#[test]
fn syncing_is_permissionless() {
    // Anyone may refresh the rail. It publishes what other accounts already
    // say, so gatekeeping it would only make the published copy staler.
    let mut venue = Venue::rail(VenueConfig::default());
    let instruction = ix(
        crate::accounts::ReadSecurity {
            security: venue.security,
            underlying_mint: venue.underlying(),
            primary_oracle: SCOPE_PRICES,
            secondary_oracle: SCOPE_PRICES,
        },
        crate::instruction::SyncSecurity {},
    );
    let stranger = venue.holder.insecure_clone();
    send(&mut venue.svm, &[instruction], &stranger, &[]).expect("sync should be permissionless");
}

#[test]
fn attest_halt_rejects_a_signature_from_anyone_but_the_attestor() {
    let mut venue = Venue::rail(VenueConfig::default());

    let impostor = venue.authority.insecure_clone(); // the registry authority, not the attestor
    let instruction = ix(
        crate::accounts::AttestHalt {
            attestor: impostor.pubkey().to_bytes().into(),
            registry: venue.registry,
            security: venue.security,
        },
        crate::instruction::AttestHalt {
            halted: true,
            since_ts: venue.config.now,
            source: 1,
        },
    );
    assert!(
        send(&mut venue.svm, &[instruction], &impostor, &[]).is_err(),
        "the registry authority is not the attestor"
    );
    assert!(!venue.security_state().halt.halted);
}

#[test]
fn the_attestor_can_set_and_clear_a_halt() {
    let mut venue = Venue::rail(VenueConfig::default());
    let attestor = venue.attestor.insecure_clone();
    let authority = venue.authority.insecure_clone();

    let set = ix(
        crate::accounts::AttestHalt {
            attestor: attestor.pubkey().to_bytes().into(),
            registry: venue.registry,
            security: venue.security,
        },
        crate::instruction::AttestHalt {
            halted: true,
            since_ts: venue.config.now - 120,
            source: 1,
        },
    );
    send(&mut venue.svm, &[set], &authority, &[&attestor]).expect("attest failed");

    let halt = venue.security_state().halt;
    assert!(halt.halted);
    assert_eq!(halt.since_ts, venue.config.now - 120);
    assert_eq!(halt.attested_ts, venue.config.now);

    // ...and while it is set, the gate refuses with code 2.
    let probe = venue.probe_security().expect("probe should not revert");
    assert_eq!(
        refusal_code_in_logs(&probe.logs),
        Some(RefusalCode::Halted as u8)
    );

    let clear = ix(
        crate::accounts::AttestHalt {
            attestor: attestor.pubkey().to_bytes().into(),
            registry: venue.registry,
            security: venue.security,
        },
        crate::instruction::AttestHalt {
            halted: false,
            since_ts: 0,
            source: 1,
        },
    );
    send(&mut venue.svm, &[clear], &authority, &[&attestor]).expect("clear failed");
    assert!(!venue.security_state().halt.halted);
}

#[test]
fn register_security_rejects_a_mint_with_no_scaled_ui_amount() {
    // USDC is a real mint under the original token program and has no way to
    // tell us a corporate action happened. A contract written on a security we
    // cannot re-cut is a contract that will one day be wrong by a split.
    let mut venue = Venue::rail(VenueConfig::default());
    venue
        .svm
        .set_account(USDC_MINT, usdc_mint_account())
        .unwrap();

    let usdc = Pubkey::new_from_array(USDC_MINT.to_bytes());
    let security = Pubkey::find_program_address(&[SECURITY_SEED, usdc.as_ref()], &crate::ID).0;
    let authority = venue.authority.insecure_clone();
    let instruction = ix(
        crate::accounts::RegisterSecurity {
            authority: authority.pubkey().to_bytes().into(),
            registry: Pubkey::find_program_address(&[REGISTRY_SEED], &crate::ID).0,
            underlying_mint: usdc,
            calendar: venue.calendar,
            security,
            system_program: anchor_lang::system_program::ID,
        },
        crate::instruction::RegisterSecurity {
            symbol: symbol(b"USDC"),
            sources: OracleBinding::Pair {
                primary: OracleSource::Scope {
                    index: SCOPE_AAPLX_CHECKED,
                },
                secondary: OracleSource::Scope {
                    index: SCOPE_AAPLX_LAZER,
                },
            },
            max_price_age: 60,
            max_conf_bps: 100,
            max_divergence_bps: 150,
        },
    );
    let failed = send(&mut venue.svm, &[instruction], &authority, &[])
        .expect_err("a mint without ScaledUiAmount is not a security we can price");
    assert!(
        failed
            .meta
            .logs
            .iter()
            .any(|l| l.contains("MissingScaledUiAmount")),
        "{:?}",
        failed.meta.logs
    );
}

#[test]
fn probe_security_counts_the_refusal_the_weekend_produces() {
    // Sunday 09:15Z, with Scope's timestamp seconds old — every freshness check
    // a program can perform passes, and the calendar still says no.
    let mut venue = Venue::rail(VenueConfig::default());
    venue.at(HERO_TS);

    let meta = venue.probe_security().expect("the probe itself must succeed");
    assert_eq!(
        refusal_code_in_logs(&meta.logs),
        Some(RefusalCode::MarketClosed as u8)
    );

    let state = venue.security_state();
    assert_eq!(state.refusals, 1);
    assert_eq!(state.last_refusal_code, RefusalCode::MarketClosed as u8);
    assert_eq!(state.last_refusal_ts, HERO_TS);
}

#[test]
fn probe_security_is_silent_when_the_security_is_actionable() {
    let mut venue = Venue::rail(VenueConfig::default());
    let meta = venue.probe_security().expect("probe failed");
    assert_eq!(refusal_code_in_logs(&meta.logs), None);
    assert_eq!(venue.security_state().refusals, 0);
}

#[test]
fn a_security_bound_to_one_declared_source_is_registered_and_not_actionable() {
    // Registering it is allowed, because one source is sometimes all there is.
    // Acting on it is not, and the code says which of the two problems it is.
    let mut venue = Venue::rail(VenueConfig {
        single_source: true,
        ..VenueConfig::default()
    });
    venue.sync_security().expect("sync failed");

    let state = venue.security_state();
    assert!(state.sources.secondary().is_none());
    assert!(state.secondary.is_none());
    assert!(state.primary.price > 0, "it still publishes a price");

    let meta = venue.probe_security().expect("probe failed");
    assert_eq!(
        refusal_code_in_logs(&meta.logs),
        Some(RefusalCode::SingleSource as u8)
    );
}

#[test]
fn a_security_is_its_mint_and_cannot_be_registered_twice() {
    let mut venue = Venue::rail(VenueConfig::default());
    let authority = venue.authority.insecure_clone();
    let instruction = ix(
        crate::accounts::RegisterSecurity {
            authority: authority.pubkey().to_bytes().into(),
            registry: venue.registry,
            underlying_mint: venue.underlying(),
            calendar: venue.calendar,
            security: venue.security,
            system_program: anchor_lang::system_program::ID,
        },
        crate::instruction::RegisterSecurity {
            symbol: symbol(b"AAPLx"),
            sources: OracleBinding::Pair {
                primary: OracleSource::Scope {
                    index: SCOPE_AAPLX_CHECKED,
                },
                secondary: OracleSource::Scope {
                    index: SCOPE_AAPLX_LAZER,
                },
            },
            max_price_age: 60,
            max_conf_bps: 100,
            max_divergence_bps: 150,
        },
    );
    assert!(send(&mut venue.svm, &[instruction], &authority, &[]).is_err());
}

#[test]
fn an_oracle_account_from_the_wrong_program_is_refused() {
    let mut venue = Venue::rail(VenueConfig::default());
    // A correctly-shaped Scope account owned by somebody else is not Scope.
    let impostor = SvmPubkey::new_unique();
    let mut account = venue
        .svm
        .get_account(&SvmPubkey::from(SCOPE_PRICES.to_bytes()))
        .unwrap();
    account.owner = SvmPubkey::new_unique();
    venue.svm.set_account(impostor, account).unwrap();

    let instruction = ix(
        crate::accounts::ReadSecurity {
            security: venue.security,
            underlying_mint: venue.underlying(),
            primary_oracle: Pubkey::new_from_array(impostor.to_bytes()),
            secondary_oracle: Pubkey::new_from_array(impostor.to_bytes()),
        },
        crate::instruction::SyncSecurity {},
    );
    let authority = venue.authority.insecure_clone();
    assert!(send(&mut venue.svm, &[instruction], &authority, &[]).is_err());
}
