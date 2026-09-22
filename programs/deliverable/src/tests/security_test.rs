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
use super::venue::{ix, refusal_code_in_logs, send, symbol, TxResult, Venue, VenueConfig, HERO_TS};

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

/// A copy of the real Scope account, owned by some other program. `observe()`
/// rejects it, so any instruction that reads it fails.
///
/// This fixture rewrites the **owner**, which is why it could never see F-01:
/// the hole was an account with the *right* owner at the *wrong* address. See
/// [`plant_correctly_owned_impostor`], which is the version that could.
fn plant_impostor_oracle(venue: &mut Venue) -> Pubkey {
    let impostor = SvmPubkey::new_unique();
    let mut account = venue
        .svm
        .get_account(&SvmPubkey::from(SCOPE_PRICES.to_bytes()))
        .unwrap();
    account.owner = SvmPubkey::new_unique();
    venue.svm.set_account(impostor, account).unwrap();
    Pubkey::new_from_array(impostor.to_bytes())
}

/// A byte-for-byte copy of the real Scope account under the **real** Scope
/// program, at a different address.
///
/// Right owner, right discriminator, right length, right prices: everything
/// the program used to check, and none of it is identity. Scope hosts several
/// `OraclePrices` feeds — five were live on mainnet when this was written, and
/// 150 indices were populated in the bound feed and simultaneously fresh in a
/// sibling with completely unrelated prices — so this is not a manufactured
/// account, it is the shape of one that already exists.
fn plant_correctly_owned_impostor(venue: &mut Venue) -> Pubkey {
    let impostor = SvmPubkey::new_unique();
    let account = venue
        .svm
        .get_account(&SvmPubkey::from(SCOPE_PRICES.to_bytes()))
        .unwrap();
    venue.svm.set_account(impostor, account).unwrap();
    Pubkey::new_from_array(impostor.to_bytes())
}

#[test]
fn a_correctly_owned_scope_account_at_the_wrong_address_is_refused() {
    let mut venue = Venue::rail(VenueConfig::default());
    let impostor = plant_correctly_owned_impostor(&mut venue);

    // Nothing distinguishes it from the bound feed except its address.
    let real = venue
        .svm
        .get_account(&SvmPubkey::from(SCOPE_PRICES.to_bytes()))
        .unwrap();
    let planted = venue
        .svm
        .get_account(&SvmPubkey::from(impostor.to_bytes()))
        .unwrap();
    assert_eq!(planted.owner, real.owner, "the real Scope program");
    assert_eq!(planted.data, real.data, "byte for byte");

    // The rail refuses to publish from it...
    let instruction = ix(
        crate::accounts::ReadSecurity {
            security: venue.security,
            underlying_mint: venue.underlying(),
            primary_oracle: impostor,
            secondary_oracle: impostor,
        },
        crate::instruction::SyncSecurity {},
    );
    let authority = venue.authority.insecure_clone();
    let refused = send(&mut venue.svm, &[instruction], &authority, &[])
        .expect_err("an unbound Scope feed is not this security's price");
    assert!(
        refused
            .meta
            .logs
            .iter()
            .any(|l| l.contains("OracleSourceMismatch")),
        "{:?}",
        refused.meta.logs
    );

    // ...and the gate records it as a read it could not make, rather than
    // acting on a price from an account nobody bound.
    let meta = probe_with_oracle(&mut venue, impostor).expect("the probe records rather than reverts");
    assert_eq!(
        refusal_code_in_logs(&meta.logs),
        Some(RefusalCode::OracleUnreadable as u8)
    );
    assert_eq!(venue.security_state().synced_ts, 0, "nothing was published");
}

fn probe_with_oracle(venue: &mut Venue, oracle: Pubkey) -> TxResult {
    let instruction = ix(
        crate::accounts::ProbeSecurity {
            security: venue.security,
            calendar: venue.calendar,
            underlying_mint: venue.underlying(),
            primary_oracle: oracle,
            secondary_oracle: oracle,
        },
        crate::instruction::ProbeSecurity {},
    );
    let authority = venue.authority.insecure_clone();
    send(&mut venue.svm, &[instruction], &authority, &[])
}

#[test]
fn a_closed_market_is_refused_before_any_oracle_is_read() {
    // The README says the calendar decides a closed market by arithmetic, before
    // an oracle is touched. This is the test that holds us to it: hand the
    // program an oracle account it would reject outright, on a Sunday. If the
    // oracle were read first, the instruction would fail on the impostor. It
    // must instead succeed and record MarketClosed.
    let mut venue = Venue::rail(VenueConfig::default());
    venue.at(HERO_TS);
    let impostor = plant_impostor_oracle(&mut venue);

    let meta = probe_with_oracle(&mut venue, impostor)
        .expect("a closed market must be decided without reading the oracle");
    assert_eq!(
        refusal_code_in_logs(&meta.logs),
        Some(RefusalCode::MarketClosed as u8)
    );
    assert_eq!(
        venue.security_state().last_refusal_code,
        RefusalCode::MarketClosed as u8
    );
}

#[test]
fn the_same_impostor_oracle_is_rejected_once_the_market_is_open() {
    // Negative control for the test above. Without it, that test would also pass
    // if the impostor were simply never rejected by anything.
    //
    // The probe is total — it has to be, or the refusal ledger cannot record the
    // one condition it exists for — so "rejected" here is a recorded refusal
    // rather than a reverted transaction. The distinction the control is making
    // is still the one that matters: on a Sunday the answer is `MarketClosed`
    // and the account is never read; in an open session the account is read,
    // and this one is not the oracle this security is bound to.
    let mut venue = Venue::rail(VenueConfig::default());
    let impostor = plant_impostor_oracle(&mut venue);
    let meta = probe_with_oracle(&mut venue, impostor).expect("the probe records rather than reverts");
    assert_eq!(
        refusal_code_in_logs(&meta.logs),
        Some(RefusalCode::OracleUnreadable as u8),
        "an open market must read the oracle, and this one is not Scope"
    );
    assert_eq!(venue.security_state().refusals, 1);
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
