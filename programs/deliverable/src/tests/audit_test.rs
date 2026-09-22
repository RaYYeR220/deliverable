//! Adversarial audit reproductions.
//!
//! Every test in this file failed against the program as it was written, and
//! names the finding it demonstrates. They ran `#[ignore]`d while the evidence
//! sat in the tree waiting for the fix; they run in the ordinary suite now, so
//! each one guards the behaviour that made it pass.
//!
//! Several of them had to be turned around to do that, because a reproduction
//! is written to assert that an exploit *works*: `.expect("exercise")` on a
//! step the program must now refuse is an assertion that the hole is still
//! open. Where that happened the attack is unchanged and the assertion on it
//! is inverted — the refusal is named, and the finding's own headline
//! assertion (whose money ended up where) is kept exactly as the audit wrote
//! it. Each such test says so in its own comment.
//!
//! Findings are numbered as in `_internal/audit.md`.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensionsMut, PodStateWithExtensionsMut,
};
use anchor_spl::token_2022::spl_token_2022::pod::PodMint;
use litesvm::LiteSVM;
use solana_keypair::Keypair;
use solana_pubkey::Pubkey as SvmPubkey;
use solana_signer::Signer as _;

use crate::constants::{
    SCALE, SCOPE_ENTRY_SIZE, SCOPE_PRICES, SCOPE_PRICES_OFFSET, SCOPE_PROGRAM, WRITER_SEED,
};
use crate::error::RefusalCode;
use crate::fixed::f64_bits_to_fixed;
use crate::state::{MarketCalendar, OptionKind, OptionSeries, WriterPosition};

use super::harness::{
    et, AAPLX_MINT, SCOPE_AAPLX_CHECKED, SCOPE_AAPLX_LAZER, TOKEN_2022, TOKEN_LEGACY, USDC_MINT,
};
use super::venue::{
    anchor_key, balance_of, exercise_ts, ix, must_send, refusal_code_in_logs, send, settled_ts,
    svm_key_of, token_account, Venue, VenueConfig, TxResult, CONTRACT_RAW_SIZE,
    XSTOCK_ACCOUNT_EXTENSIONS,
};

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/// A second (third, …) writer on the same series: funded, with a position open.
pub struct ExtraWriter {
    pub kp: Keypair,
    pub underlying: SvmPubkey,
    pub option: SvmPubkey,
    pub quote: SvmPubkey,
    pub position: Pubkey,
}

fn add_writer(venue: &mut Venue, aaplx: u64) -> ExtraWriter {
    let kp = Keypair::new();
    venue.svm.airdrop(&kp.pubkey(), 100_000_000_000).unwrap();

    let underlying = SvmPubkey::new_unique();
    let option = SvmPubkey::new_unique();
    let quote = SvmPubkey::new_unique();
    venue
        .svm
        .set_account(
            underlying,
            token_account(
                AAPLX_MINT,
                kp.pubkey(),
                aaplx,
                TOKEN_2022,
                &XSTOCK_ACCOUNT_EXTENSIONS,
            ),
        )
        .unwrap();
    venue
        .svm
        .set_account(
            option,
            token_account(svm_key_of(venue.option_mint), kp.pubkey(), 0, TOKEN_2022, &[]),
        )
        .unwrap();
    venue
        .svm
        .set_account(quote, token_account(USDC_MINT, kp.pubkey(), 0, TOKEN_LEGACY, &[]))
        .unwrap();

    let position = Pubkey::find_program_address(
        &[
            WRITER_SEED,
            venue.series.as_ref(),
            anchor_key(kp.pubkey()).as_ref(),
        ],
        &crate::ID,
    )
    .0;

    must_send(
        &mut venue.svm,
        &[ix(
            crate::accounts::OpenPosition {
                writer: anchor_key(kp.pubkey()),
                series: venue.series,
                position,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::OpenPosition {},
        )],
        &kp,
        &[],
    );

    ExtraWriter {
        kp,
        underlying,
        option,
        quote,
        position,
    }
}

fn write_as(venue: &mut Venue, w: &ExtraWriter, contracts: u64) -> TxResult {
    let instruction = ix(
        crate::accounts::Write {
            writer: anchor_key(w.kp.pubkey()),
            registry: venue.registry,
            security: venue.security,
            calendar: venue.calendar,
            series: venue.series,
            underlying_mint: venue.underlying(),
            premium_vault: venue.premium_vault,
            option_mint: venue.option_mint,
            collateral_vault: venue.collateral_vault,
            writer_underlying: anchor_key(w.underlying),
            writer_option: anchor_key(w.option),
            position: w.position,
            primary_oracle: SCOPE_PRICES,
            secondary_oracle: SCOPE_PRICES,
            underlying_token_program: anchor_key(TOKEN_2022),
        },
        crate::instruction::Write { contracts },
    );
    let kp = w.kp.insecure_clone();
    send(&mut venue.svm, &[instruction], &kp, &[])
}

fn settle_as(venue: &mut Venue, w: &ExtraWriter) -> TxResult {
    let instruction = ix(
        crate::accounts::SettleExpired {
            writer: anchor_key(w.kp.pubkey()),
            security: venue.security,
            calendar: venue.calendar,
            series: venue.series,
            position: w.position,
            underlying_mint: venue.underlying(),
            quote_mint: venue.quote(),
            collateral_vault: venue.collateral_vault,
            quote_vault: venue.quote_vault,
            writer_underlying: anchor_key(w.underlying),
            writer_quote: anchor_key(w.quote),
            underlying_token_program: anchor_key(TOKEN_2022),
            quote_token_program: anchor_key(TOKEN_LEGACY),
        },
        crate::instruction::SettleExpired {},
    );
    let kp = w.kp.insecure_clone();
    send(&mut venue.svm, &[instruction], &kp, &[])
}

fn claim_as(venue: &mut Venue, w: &ExtraWriter) -> TxResult {
    let instruction = ix(
        crate::accounts::ClaimPremium {
            writer: anchor_key(w.kp.pubkey()),
            registry: venue.registry,
            security: venue.security,
            calendar: venue.calendar,
            series: venue.series,
            position: w.position,
            underlying_mint: venue.underlying(),
            premium_vault: venue.premium_vault,
            writer_underlying: anchor_key(w.underlying),
            primary_oracle: SCOPE_PRICES,
            secondary_oracle: SCOPE_PRICES,
            underlying_token_program: anchor_key(TOKEN_2022),
        },
        crate::instruction::ClaimPremium {},
    );
    let kp = w.kp.insecure_clone();
    send(&mut venue.svm, &[instruction], &kp, &[])
}

/// A brand-new account, owned by the **real** Kamino Scope program, whose two
/// bound entries carry a price of the caller's choosing stamped `publish_ts`.
///
/// Nothing here is exotic: it is a Scope-owned account that is not
/// `SCOPE_PRICES`. On mainnet the same thing is any other Scope feed's
/// `OraclePrices` (Scope hosts many), or one the attacker creates.
fn forged_scope_account(svm: &mut LiteSVM, price: u64, publish_ts: i64) -> Pubkey {
    let key = SvmPubkey::new_unique();
    let mut data = vec![0u8; 28_712];
    for index in [SCOPE_AAPLX_CHECKED, SCOPE_AAPLX_LAZER] {
        let start = SCOPE_PRICES_OFFSET + index as usize * SCOPE_ENTRY_SIZE;
        data[start..start + 8].copy_from_slice(&price.to_le_bytes());
        data[start + 8..start + 16].copy_from_slice(&6u64.to_le_bytes()); // exp
        data[start + 16..start + 24].copy_from_slice(&1u64.to_le_bytes()); // slot
        data[start + 24..start + 32].copy_from_slice(&(publish_ts as u64).to_le_bytes());
    }
    svm.set_account(
        key,
        solana_account::Account {
            lamports: 1_000_000_000,
            data,
            owner: SvmPubkey::from(SCOPE_PROGRAM.to_bytes()),
            executable: false,
            rent_epoch: u64::MAX,
        },
    )
    .unwrap();
    anchor_key(key)
}

/// Move the real Scope account's publication time back so the gate must refuse
/// `OracleStale`.
fn stale_the_real_scope(venue: &mut Venue, now: i64) {
    let account = super::harness::scope_prices_account_at(now - 3_600);
    venue
        .svm
        .set_account(SvmPubkey::from(SCOPE_PRICES.to_bytes()), account)
        .unwrap();
}

fn write_with_oracles(venue: &mut Venue, contracts: u64, primary: Pubkey, secondary: Pubkey) -> TxResult {
    let instruction = ix(
        crate::accounts::Write {
            writer: anchor_key(venue.writer.pubkey()),
            registry: venue.registry,
            security: venue.security,
            calendar: venue.calendar,
            series: venue.series,
            underlying_mint: venue.underlying(),
            premium_vault: venue.premium_vault,
            option_mint: venue.option_mint,
            collateral_vault: venue.collateral_vault,
            writer_underlying: anchor_key(venue.writer_underlying),
            writer_option: anchor_key(venue.writer_option),
            position: venue.position,
            primary_oracle: primary,
            secondary_oracle: secondary,
            underlying_token_program: anchor_key(TOKEN_2022),
        },
        crate::instruction::Write { contracts },
    );
    let writer = venue.writer.insecure_clone();
    send(&mut venue.svm, &[instruction], &writer, &[])
}

fn sync_with_oracles(venue: &mut Venue, primary: Pubkey, secondary: Pubkey) -> TxResult {
    let instruction = ix(
        crate::accounts::ReadSecurity {
            security: venue.security,
            underlying_mint: venue.underlying(),
            primary_oracle: primary,
            secondary_oracle: secondary,
        },
        crate::instruction::SyncSecurity {},
    );
    let authority = venue.authority.insecure_clone();
    send(&mut venue.svm, &[instruction], &authority, &[])
}

/// Overwrite the AAPLx mint's `ScaledUiAmount` multiplier in place.
///
/// This is the issuer's lever, not ours — the point of the test is that the
/// program applies whatever the mint says with no bound of its own.
fn set_mint_multiplier(svm: &mut LiteSVM, multiplier: f64, effective_ts: i64) {
    let mut account = svm.get_account(&AAPLX_MINT).unwrap();
    {
        let mut state = PodStateWithExtensionsMut::<PodMint>::unpack(&mut account.data).unwrap();
        let cfg = state.get_extension_mut::<ScaledUiAmountConfig>().unwrap();
        cfg.multiplier = multiplier.into();
        cfg.new_multiplier = multiplier.into();
        cfg.new_multiplier_effective_timestamp = effective_ts.into();
    }
    svm.set_account(AAPLX_MINT, account).unwrap();
}

fn series_for(strike0: u64, m0: u128, raw: u64, decimals: u8) -> OptionSeries {
    OptionSeries {
        security: Pubkey::default(),
        underlying_mint: Pubkey::default(),
        quote_mint: Pubkey::default(),
        option_mint: Pubkey::default(),
        collateral_vault: Pubkey::default(),
        premium_vault: Pubkey::default(),
        quote_vault: Pubkey::default(),
        creator: Pubkey::default(),
        kind: OptionKind::Call,
        expiry_ts: 0,
        strike0,
        multiplier_at_mint: m0,
        contract_raw_size: raw,
        settlement_window_minutes: 30,
        adjust_on_corporate_action: true,
        underlying_decimals: decimals,
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

// ---------------------------------------------------------------------------
// F-01 — the Scope oracle account is not bound to an address
// ---------------------------------------------------------------------------

/// `oracle::observe` checks only that the account is *owned by* the Scope
/// program. `SCOPE_PRICES` is declared in `constants.rs` and never compared
/// against anything. Any Scope-owned account is therefore an acceptable price
/// source, at any index.
#[test]
fn a_forged_scope_account_defeats_the_staleness_refusal() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    let now = venue.config.now;

    // The real feed stops publishing: an hour-old stamp inside an open session.
    stale_the_real_scope(&mut venue, now);
    let refused = write_with_oracles(&mut venue, 1, SCOPE_PRICES, SCOPE_PRICES)
        .expect_err("the real feed is an hour stale");
    assert_eq!(
        refusal_code_in_logs(&refused.meta.logs),
        Some(RefusalCode::OracleStale as u8),
        "{:?}",
        refused.meta.logs
    );

    // The same instruction, with an account the attacker owns the bytes of.
    let vault_before = balance_of(&venue.svm, svm_key_of(venue.collateral_vault));
    let forged = forged_scope_account(&mut venue.svm, 340_098_163, now - 1);
    let accepted = write_with_oracles(&mut venue, 1, forged, forged);
    let vault_after = balance_of(&venue.svm, svm_key_of(venue.collateral_vault));

    assert!(
        accepted.is_err(),
        "FINDING F-01: a Scope-owned impostor that is not SCOPE_PRICES passed \
         the gate while the bound feed was an hour stale; {} raw of collateral \
         moved",
        vault_after - vault_before
    );
}

/// The same hole, aimed at the rail rather than the venue: `sync_security` is
/// permissionless and writes whatever the passed account says into the
/// `SecurityState` that "any program or indexer can read without a CPI".
#[test]
fn anyone_can_publish_an_arbitrary_price_onto_the_rail() {
    let mut venue = Venue::rail(VenueConfig::default());
    let now = venue.config.now;

    let forged = forged_scope_account(&mut venue.svm, 1, now - 1);
    // The attack step is now the refusal: `observe` binds the account by
    // address before it reads a byte, so the impostor never reaches the rail.
    assert!(
        sync_with_oracles(&mut venue, forged, forged).is_err(),
        "FINDING F-01: sync_security accepted an unbound Scope-owned account"
    );

    let state = venue.security_state();
    assert_ne!(
        state.primary.price, 1,
        "FINDING F-01: the rail published an attacker-chosen price ({})",
        state.primary.price
    );
}

/// Divergence is the project's stand-in for a confidence band. It is computed
/// from two entries of whatever account is handed in, so one impostor
/// satisfies both legs at once.
#[test]
fn one_forged_account_corroborates_itself() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    let now = venue.config.now;

    // Make the two real entries disagree far beyond 150 bps.
    let mut account = super::harness::scope_prices_account_at(now - 1);
    let start = SCOPE_PRICES_OFFSET + SCOPE_AAPLX_LAZER as usize * SCOPE_ENTRY_SIZE;
    account.data[start..start + 8].copy_from_slice(&1_000_000_000u64.to_le_bytes());
    venue
        .svm
        .set_account(SvmPubkey::from(SCOPE_PRICES.to_bytes()), account)
        .unwrap();

    let refused = write_with_oracles(&mut venue, 1, SCOPE_PRICES, SCOPE_PRICES)
        .expect_err("the two real entries disagree");
    assert_eq!(
        refusal_code_in_logs(&refused.meta.logs),
        Some(RefusalCode::SourcesDisagree as u8)
    );

    let forged = forged_scope_account(&mut venue.svm, 340_098_163, now - 1);
    assert!(
        write_with_oracles(&mut venue, 1, forged, forged).is_err(),
        "FINDING F-01: both legs of the corroboration requirement were \
         satisfied by one attacker-supplied account"
    );
}

// ---------------------------------------------------------------------------
// F-02 — assignment rounds down for every writer, and the shortfall is
//        silently clamped onto whoever settles last
// ---------------------------------------------------------------------------

/// Pure arithmetic: three equal writers, one contract exercised.
///
/// `assigned` floors to 0 for all three, so all three ask for their whole
/// collateral back while the vault is one contract short.
#[test]
fn assignment_rounding_leaves_the_vault_short_of_what_writers_reclaim() {
    let mut series = series_for(340_000_000, SCALE, CONTRACT_RAW_SIZE, 8);
    series.contracts_written = 3;
    series.contracts_exercised = 1;

    let mut reclaimed = 0u64;
    for _ in 0..3 {
        let position = WriterPosition {
            owner: Pubkey::default(),
            series: Pubkey::default(),
            contracts: 1,
            raw_collateral: CONTRACT_RAW_SIZE,
            premium_claimed: 0,
            settled: false,
            bump: 0,
            premium_debt: 0,
        };
        let assigned = position.assigned(&series).unwrap();
        assert_eq!(assigned, 0, "floor(1 * 1 / 3)");
        reclaimed += series.delivery_raw(position.contracts - assigned).unwrap();
    }

    let in_vault = series
        .delivery_raw(series.contracts_written - series.contracts_exercised)
        .unwrap();
    assert!(
        reclaimed > in_vault,
        "writers reclaim {reclaimed} raw from a vault holding {in_vault}"
    );
    assert_eq!(reclaimed - in_vault, CONTRACT_RAW_SIZE, "one whole contract");

    // ...which is why settlement does not use it. The conserving assignment,
    // run over the same three writers in settlement order, gives the vault
    // back exactly what it holds.
    let mut assigned_total = 0u64;
    let mut conserving_reclaim = 0u64;
    for _ in 0..3 {
        series.contracts_assigned_total = assigned_total;
        let position = WriterPosition {
            owner: Pubkey::default(),
            series: Pubkey::default(),
            contracts: 1,
            raw_collateral: CONTRACT_RAW_SIZE,
            premium_claimed: 0,
            settled: false,
            bump: 0,
            premium_debt: 0,
        };
        let assigned = position.conserving_assignment(&series).unwrap();
        assigned_total += assigned;
        conserving_reclaim += series.delivery_raw(position.contracts - assigned).unwrap();
    }
    assert_eq!(assigned_total, series.contracts_exercised, "assignment sums");
    assert_eq!(conserving_reclaim, in_vault, "and the vault is exactly empty");
}

/// The audit's deliberate amplification, at its own numbers: a hundred dust
/// keypairs of one contract each against an honest whale holding a hundred.
///
/// `floor(1 x 100 / 200)` is zero for every dust position and
/// `floor(100 x 100 / 200)` is fifty for the whale, so the hundred dust
/// positions reclaimed a hundred contracts, drained the vault, and the whale's
/// fifty-contract return clamped to nothing — fifty real AAPLx shares, about
/// $17,000, transferred on settlement order alone. The dust costs the attacker
/// nothing: `write` is legal until the instant of expiry and the collateral
/// comes back thirty open minutes later.
#[test]
fn a_dust_swarm_cannot_drain_the_whales_collateral() {
    const DUST: u64 = 100;
    let mut series = series_for(340_000_000, SCALE, CONTRACT_RAW_SIZE, 8);
    series.contracts_written = 2 * DUST;
    series.contracts_exercised = DUST;

    let position = |contracts: u64| WriterPosition {
        owner: Pubkey::default(),
        series: Pubkey::default(),
        contracts,
        raw_collateral: contracts * CONTRACT_RAW_SIZE,
        premium_claimed: 0,
        settled: false,
        bump: 0,
        premium_debt: 0,
    };

    // The dust rushes in first, which is the attack: whoever settles early
    // used to be the one who escaped assignment.
    let mut assigned_total = 0u64;
    let mut reclaimed = 0u64;
    for _ in 0..DUST {
        series.contracts_assigned_total = assigned_total;
        let dust = position(1);
        let assigned = dust.conserving_assignment(&series).unwrap();
        assigned_total += assigned;
        reclaimed += series.delivery_raw(dust.contracts - assigned).unwrap();
    }
    series.contracts_assigned_total = assigned_total;

    let whale = position(DUST);
    let whale_assigned = whale.conserving_assignment(&series).unwrap();
    let whale_back = series
        .delivery_raw(whale.contracts - whale_assigned)
        .unwrap();
    reclaimed += whale_back;

    let in_vault = series
        .delivery_raw(series.contracts_written - series.contracts_exercised)
        .unwrap();
    assert_eq!(
        assigned_total + whale_assigned,
        series.contracts_exercised,
        "assignment is exact, so nobody is short"
    );
    assert_eq!(reclaimed, in_vault, "the vault covers every return exactly");
    assert_eq!(
        whale_back,
        DUST * CONTRACT_RAW_SIZE,
        "the whale's collateral is not the dust's to take"
    );
}

/// End to end, against the real mint: two writers, one contract each, one
/// exercised. The writer who settles first walks away with collateral that
/// belongs to the assignment, and the second writer gets nothing back.
#[test]
fn the_first_writer_to_settle_takes_the_second_writers_collateral() {
    let mut venue = Venue::listed(VenueConfig::default());
    let second = add_writer(&mut venue, CONTRACT_RAW_SIZE);

    venue.write(1).expect("writer one");
    write_as(&mut venue, &second, 1).expect("writer two");

    // One contract reaches a holder and is exercised.
    venue.hand_option_to_holder(1);
    venue.at(exercise_ts());
    venue.exercise(1).expect("exercise");

    let vault = balance_of(&venue.svm, svm_key_of(venue.collateral_vault));
    assert_eq!(vault, CONTRACT_RAW_SIZE, "one contract of collateral is left");

    venue.at(settled_ts());
    venue.settle_expired().expect("writer one settles");
    settle_as(&mut venue, &second).expect("writer two settles");

    let first_back = balance_of(&venue.svm, venue.writer_underlying);
    let second_back = balance_of(&venue.svm, second.underlying);

    assert_eq!(
        second_back, CONTRACT_RAW_SIZE,
        "FINDING F-02: writer two was assigned nothing on the books \
         (floor(1*1/2)=0) yet received {second_back} raw back instead of \
         {CONTRACT_RAW_SIZE}; writer one left with {first_back}"
    );
}

// ---------------------------------------------------------------------------
// F-03 — premium is split by the book as it stands at claim time
// ---------------------------------------------------------------------------

/// Premium that arrived while one writer was the whole book is re-divided the
/// moment anybody else writes. The later writer took on no risk over the
/// period the premium paid for.
#[test]
fn premium_earned_before_a_writer_existed_is_shared_with_them() {
    let mut venue = Venue::listed(VenueConfig::default());
    venue.write(1).expect("writer one");

    const PREMIUM: u64 = 10_000_000;
    venue.deposit_premium(PREMIUM);

    // A second writer arrives after the premium is already in the vault.
    let second = add_writer(&mut venue, CONTRACT_RAW_SIZE);
    write_as(&mut venue, &second, 1).expect("writer two");

    let before = balance_of(&venue.svm, venue.writer_underlying);
    venue.claim_premium().expect("writer one claims");
    let paid = balance_of(&venue.svm, venue.writer_underlying) - before;

    assert_eq!(
        paid, PREMIUM,
        "FINDING F-03: writer one earned {PREMIUM} of premium and was paid {paid}"
    );
}

/// Worse than dilution: once the denominator has grown past a completed claim,
/// the arithmetic asks for more than the vault holds and the transfer fails.
/// The premium sitting in the vault is unreachable by anybody.
#[test]
fn premium_is_stranded_when_the_book_grows_after_a_claim() {
    let mut venue = Venue::listed(VenueConfig::default());
    venue.write(1).expect("writer one");

    venue.deposit_premium(10_000_000);
    venue.claim_premium().expect("writer one takes the lot");

    let second = add_writer(&mut venue, CONTRACT_RAW_SIZE);
    write_as(&mut venue, &second, 1).expect("writer two");
    venue.deposit_premium(2_000_000);

    // Both writers hold one contract of a two-contract book while the second
    // 2_000_000 arrives, so the accumulator credits each of them half of it.
    // Under the old pro-rata-at-claim-time arithmetic writer one's entitlement
    // was recomputed as 6_000_000 against 10_000_000 already taken, which
    // saturated to zero and locked them out, while writer two was told they
    // were owed 6_000_000 out of a vault holding 2_000_000 — and the whole
    // 2_000_000 was unreachable by either of them.
    let first_before = balance_of(&venue.svm, venue.writer_underlying);
    venue
        .claim_premium()
        .expect("writer one earned half of the second deposit");
    assert_eq!(
        balance_of(&venue.svm, venue.writer_underlying) - first_before,
        1_000_000
    );
    let second_claim = claim_as(&mut venue, &second);

    let stranded = balance_of(&venue.svm, svm_key_of(venue.premium_vault));
    assert!(
        second_claim.is_ok() && stranded == 0,
        "FINDING F-03: {stranded} raw of premium is unclaimable by anyone \
         (writer two's claim: {:?})",
        second_claim.map(|_| ()).map_err(|e| e.err)
    );
}

/// `claim_premium` takes neither the registry nor the gate. Collateral-grade
/// tokens leave a series vault while the venue is paused and the market shut.
#[test]
fn premium_leaves_the_vault_while_the_venue_is_paused_and_the_market_is_shut() {
    let mut venue = Venue::listed(VenueConfig::default());
    venue.write(1).expect("write");
    venue.deposit_premium(10_000_000);

    let authority = venue.authority.insecure_clone();
    must_send(
        &mut venue.svm,
        &[ix(
            crate::accounts::SetRegistryPaused {
                authority: anchor_key(authority.pubkey()),
                registry: venue.registry,
            },
            crate::instruction::SetRegistryPaused { paused: true },
        )],
        &authority,
        &[],
    );
    venue.at(super::venue::HERO_TS); // Sunday

    let moved = venue.claim_premium();
    assert!(
        moved.is_err(),
        "FINDING F-04: premium moved with the registry paused on a Sunday"
    );
}

// ---------------------------------------------------------------------------
// F-05 — the series PDA does not cover the terms a writer cares about
// ---------------------------------------------------------------------------

/// The seed is `(mint, expiry, strike, kind)`. The quote asset, the contract
/// size, the settlement window and whether the strike adjusts at all are not
/// in it, so whoever lists first fixes all four and the canonical slot cannot
/// be relisted.
#[test]
fn a_squatter_fixes_the_terms_of_the_canonical_series() {
    let mut venue = Venue::rail(VenueConfig::default());

    // A squatter lists the canonical AAPLx $340 call — quoted in AAPLx itself,
    // one raw unit per contract, and with the strike adjustment switched off.
    let squat = ix(
        crate::accounts::CreateSeries {
            creator: anchor_key(venue.writer.pubkey()),
            registry: venue.registry,
            security: venue.security,
            calendar: venue.calendar,
            underlying_mint: venue.underlying(),
            quote_mint: venue.underlying(),
            series: venue.series,
            option_mint: venue.option_mint,
            collateral_vault: venue.collateral_vault,
            premium_vault: venue.premium_vault,
            quote_vault: venue.quote_vault,
            underlying_token_program: anchor_key(TOKEN_2022),
            quote_token_program: anchor_key(TOKEN_2022),
            system_program: anchor_lang::system_program::ID,
        },
        crate::instruction::CreateSeries {
            expiry_ts: venue.config.expiry_ts,
            strike0: venue.config.strike0,
            kind: OptionKind::Call,
            contract_raw_size: 1,
            settlement_window_minutes: 1,
            adjust_on_corporate_action: false,
        },
    );
    let squatter = venue.writer.insecure_clone();
    let listed = send(&mut venue.svm, &[squat], &squatter, &[]);
    assert!(
        listed.is_err(),
        "FINDING F-05: a squatter listed the canonical series on its own terms; \
         the honest listing can now never be created"
    );
}

// ---------------------------------------------------------------------------
// F-06 — the decoded multiplier has no upper bound, and the re-cut strike is
//        never checked for zero
// ---------------------------------------------------------------------------

/// `f64_bits_to_fixed` guards the shift *amount* with `checked_shl`, which in
/// Rust only rejects `rhs >= 128` — it does not notice significant bits
/// leaving the top of the `u128`. A multiplier above roughly `2^87` therefore
/// decodes to a wrapped value instead of failing.
#[test]
fn a_huge_multiplier_wraps_instead_of_failing() {
    let v = 2f64.powi(90);
    let decoded = f64_bits_to_fixed(v.to_bits());
    let truth = (v as u128).checked_mul(SCALE);
    assert!(
        decoded.is_err(),
        "FINDING F-06b: 2^90 decoded to {:?}, the true fixed-point value is {:?}",
        decoded.map(|d| d.to_string()),
        truth
    );
}

/// `current_strike` floors `strike0 * m0 / m1`. Nothing requires the result to
/// be non-zero, and `exercise_cost` multiplies by it, so a large enough
/// multiplier makes physical delivery free.
#[test]
fn a_large_multiplier_floors_the_strike_to_zero() {
    let series = series_for(340_000_000, SCALE, CONTRACT_RAW_SIZE, 8);
    let m1 = 10_000_000_000u128 * SCALE;

    assert_ne!(
        series.current_strike(m1).unwrap(),
        0,
        "FINDING F-06a: the re-cut strike floored to zero"
    );
    assert_ne!(
        series.exercise_cost(m1, 1).unwrap(),
        0,
        "FINDING F-06a: a contract can be exercised for nothing"
    );
}

/// The same thing driven through the compiled program against the real AAPLx
/// mint: the issuer moves the multiplier and the venue declines to price the
/// contract against it at all.
///
/// A thousandfold move is not a corporate action. At `1e10` the notional the
/// strike is supposed to preserve is not representable in a `u64` of quote
/// units — the honest per-contract cost is `$3.4` trillion — so there is no
/// number the program could charge that would be right, and the only outcomes
/// are "refuse" and "hand over a real share for a rounding error". It refuses.
#[test]
fn a_hostile_multiplier_hands_the_collateral_over_for_nothing() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.hand_option_to_holder(1);
    venue.at(exercise_ts());

    // The issuer holds this authority on every xStock.
    set_mint_multiplier(&mut venue.svm, 1e10, exercise_ts() - 1);

    let quote_before = balance_of(&venue.svm, venue.holder_quote);
    let refused = venue
        .exercise(1)
        .expect_err("a 1e10 multiplier is outside any corporate action");
    assert!(
        refused
            .meta
            .logs
            .iter()
            .any(|l| l.contains("MultiplierOutOfBand")),
        "{:?}",
        refused.meta.logs
    );

    let paid = quote_before - balance_of(&venue.svm, venue.holder_quote);
    let delivered = balance_of(&venue.svm, venue.holder_underlying);
    assert_eq!(
        (paid, delivered),
        (0, 0),
        "FINDING F-06a: the holder paid {paid} and received {delivered} raw AAPLx"
    );
    assert_eq!(
        balance_of(&venue.svm, svm_key_of(venue.collateral_vault)),
        CONTRACT_RAW_SIZE,
        "the collateral is still where the writer put it"
    );
}

/// The quiet period only sees a change the issuer *schedules*. One stamped
/// effective now, or in the past, is in force with no refusal at all.
#[test]
fn an_immediately_effective_multiplier_change_is_never_quiet() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.at(exercise_ts());
    set_mint_multiplier(&mut venue.svm, 2.0, exercise_ts());

    let probe = venue.probe_security().expect("probe should not revert");
    assert_eq!(
        refusal_code_in_logs(&probe.logs),
        Some(RefusalCode::MultiplierPending as u8),
        "FINDING F-06c: the multiplier changed underneath the venue in this very \
         slot and the gate reported nothing"
    );
}

// ---------------------------------------------------------------------------
// F-07 — the calendar is keyed by MMDD and never expires
// ---------------------------------------------------------------------------

/// `US_EQUITY_2026_2027` carries Labor Day 2026 (7 September) and the 2027
/// holidays. Keyed by MMDD with no year, each entry fires in every year the
/// calendar is left in place.
#[test]
fn the_committed_calendar_misreads_the_following_year() {
    let cal = MarketCalendar::us_equity_2026_2027();

    // 2027-09-07 is an ordinary Tuesday; Labor Day 2027 was the 6th.
    assert_eq!(
        crate::calendar::resolve_session(&cal, et(2027, 9, 7, 11, 0)),
        crate::calendar::Session::Regular,
        "FINDING F-07: a normal trading day reads as closed a year later"
    );
    // ...and the real Labor Day 2027 reads as open.
    assert_eq!(
        crate::calendar::resolve_session(&cal, et(2027, 9, 6, 11, 0)),
        crate::calendar::Session::Closed,
        "FINDING F-07: the actual holiday is not in the table"
    );
}

// ---------------------------------------------------------------------------
// F-08 — the sixteen-day scan silently truncates a long settlement window
// ---------------------------------------------------------------------------

/// `open_minutes_between` saturates to `u32::MAX` once the two instants are
/// more than sixteen calendar days apart. A settlement window longer than the
/// open minutes sixteen days can hold therefore ends early, and the phase jumps
/// from `Settling` straight past the rest of the window.
///
/// The accumulator's bound is deliberate — it is what stops a settlement call
/// being made expensive by leaving a series unsettled — so the fix is not to
/// widen the clock but to refuse at listing any window the clock cannot
/// measure, and to derive that bound from the scan bound so the two cannot
/// drift apart. This test holds both halves: the measurement that shows where
/// the clock tops out, and the refusal that keeps a window inside it.
#[test]
fn a_long_settlement_window_is_cut_short_by_the_scan_bound() {
    let cal = MarketCalendar::us_equity_2026_2027();
    let expiry = et(2026, 9, 18, 15, 50);

    let inside = crate::calendar::open_minutes_between(&cal, expiry, expiry + 16 * 86_400);
    let outside = crate::calendar::open_minutes_between(&cal, expiry, expiry + 17 * 86_400);
    assert!(
        inside >= crate::constants::MAX_SETTLEMENT_WINDOW_MINUTES as u32,
        "the listing bound of {} has to be reachable inside the {inside} open \
         minutes the scan can count before it jumps to {outside}",
        crate::constants::MAX_SETTLEMENT_WINDOW_MINUTES
    );

    // ...and a window past it is refused at listing rather than truncated at
    // settlement.
    let mut venue = Venue::rail(VenueConfig::default());
    let too_long = crate::constants::MAX_SETTLEMENT_WINDOW_MINUTES + 1;
    assert!(
        !list_with_window(&mut venue, too_long),
        "FINDING F-08: a {too_long}-minute window was listed, and the clock that \
         measures it tops out at {inside}"
    );
    assert!(
        list_with_window(&mut venue, crate::constants::MAX_SETTLEMENT_WINDOW_MINUTES),
        "a window the clock can measure must still be listable"
    );
}

/// List a series whose only unusual term is the length of its settlement
/// window. Every other argument is the venue's own.
fn list_with_window(venue: &mut Venue, settlement_window_minutes: u16) -> bool {
    let series = super::venue::series_pda(
        venue.underlying(),
        venue.quote(),
        venue.config.expiry_ts,
        venue.config.strike0,
        venue.config.contract_raw_size,
        settlement_window_minutes,
        OptionKind::Call,
        venue.config.adjust_on_corporate_action,
    );
    let instruction = ix(
        crate::accounts::CreateSeries {
            creator: anchor_key(venue.authority.pubkey()),
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
            underlying_token_program: anchor_key(TOKEN_2022),
            quote_token_program: anchor_key(TOKEN_LEGACY),
            system_program: anchor_lang::system_program::ID,
        },
        crate::instruction::CreateSeries {
            expiry_ts: venue.config.expiry_ts,
            strike0: venue.config.strike0,
            kind: OptionKind::Call,
            contract_raw_size: venue.config.contract_raw_size,
            settlement_window_minutes,
            adjust_on_corporate_action: venue.config.adjust_on_corporate_action,
        },
    );
    let creator = venue.authority.insecure_clone();
    send(&mut venue.svm, &[instruction], &creator, &[]).is_ok()
}

// ---------------------------------------------------------------------------
// F-09 — the refusal ledger cannot record an oracle that stops publishing
// ---------------------------------------------------------------------------

/// `probe_security` is the only path that can write a refusal down. It reads
/// the oracle before it reaches the gate, and a read that fails hard — an
/// entry that has gone to zero, which is what an unpublished slot looks
/// like — reverts the instruction and takes the count with it.
#[test]
fn the_refusal_ledger_cannot_count_an_oracle_outage() {
    let mut venue = Venue::rail(VenueConfig::default());
    let now = venue.config.now;

    // Both bound entries stop being published.
    let mut account = super::harness::scope_prices_account_at(now - 1);
    for index in [SCOPE_AAPLX_CHECKED, SCOPE_AAPLX_LAZER] {
        let start = SCOPE_PRICES_OFFSET + index as usize * SCOPE_ENTRY_SIZE;
        account.data[start..start + 8].copy_from_slice(&0u64.to_le_bytes());
    }
    venue
        .svm
        .set_account(SvmPubkey::from(SCOPE_PRICES.to_bytes()), account)
        .unwrap();

    let before = venue.security_state().refusals;
    let probe = venue.probe_security();
    assert!(
        probe.is_ok(),
        "FINDING F-09: probe_security reverted on an oracle outage instead of \
         recording it"
    );
    assert_eq!(venue.security_state().refusals, before + 1);
}

// ---------------------------------------------------------------------------
// F-10 — the settlement clock runs while the gate is refusing
// ---------------------------------------------------------------------------
//
// `open_minutes_between` stops for a closed market, which is the case the
// design was built around. It does not stop for any of the other six refusal
// reasons. A refusal that spans the window is therefore not a delay — it is a
// total loss for every in-the-money holder, and a windfall for the writers.

/// The attestor's signature alone is enough to expire every contract in a
/// series worthless. `attest_halt` refuses exercise; `settle_expired` takes no
/// gate; and the window keeps accruing through the halt.
///
/// Two behaviours make that false now, and this test holds both: the
/// settlement clock counts only minutes the venue was actionable in, so the
/// halt postpones settlement instead of consuming the window; and an
/// attestation nobody refreshes stops being honoured, so the attestor cannot
/// hold the position frozen by walking away.
#[test]
fn an_attested_halt_across_the_window_expires_every_option_worthless() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.hand_option_to_holder(1);

    // The attestor halts the security for the length of the window.
    let attestor = venue.attestor.insecure_clone();
    let payer = venue.authority.insecure_clone();
    venue.at(exercise_ts());
    must_send(
        &mut venue.svm,
        &[ix(
            crate::accounts::AttestHalt {
                attestor: anchor_key(attestor.pubkey()),
                registry: venue.registry,
                security: venue.security,
            },
            crate::instruction::AttestHalt {
                halted: true,
                since_ts: exercise_ts(),
                source: 1,
            },
        )],
        &payer,
        &[&attestor],
    );

    let refused = venue.exercise(1).expect_err("halted");
    assert_eq!(
        refusal_code_in_logs(&refused.meta.logs),
        Some(RefusalCode::Halted as u8)
    );

    // Wall-clock past the end of the window, and still halted. The holder
    // cannot exercise — that is what a halt is for — but the writer cannot
    // walk off with the collateral either: the window was never spent, because
    // none of it was a market the holder could act in.
    venue.at(settled_ts());
    assert!(
        venue.exercise(1).is_err(),
        "the halt is still in force, so exercise is still refused"
    );
    let early = venue
        .settle_expired()
        .expect_err("the window was refused through, not used up");
    assert!(
        early
            .meta
            .logs
            .iter()
            .any(|l| l.contains("SettlementWindowPostponed")),
        "{:?}",
        early.meta.logs
    );

    // The attestor stops refreshing. An hour after the last attestation the
    // halt is no longer a claim about the present, the gate stops honouring it,
    // and the holder gets the minutes they were refused.
    venue.at(exercise_ts() + 61 * 60);
    venue
        .exercise(1)
        .expect("the option survived a refusal that spanned its window");

    assert_eq!(
        balance_of(&venue.svm, venue.holder_underlying),
        CONTRACT_RAW_SIZE,
        "FINDING F-10: the holder received nothing; the writer kept {} raw \
         AAPLx and the holder's option is worthless, on one signature from the \
         attestor",
        balance_of(&venue.svm, svm_key_of(venue.collateral_vault))
            + balance_of(&venue.svm, venue.writer_underlying)
    );
}

/// Clearing the halt must not erase the window it consumed.
///
/// The obvious way around a clock that subtracts a halt is to lift the halt
/// once the window has run out: if the only evidence is `halt.halted`, the
/// refusal disappears from the record and the writers collect. So `HaltState`
/// keeps `since_ts` after a clear and records `lifted_ts`, and the interval
/// stays subtractable afterwards.
#[test]
fn clearing_a_halt_does_not_give_back_the_window_it_consumed() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.hand_option_to_holder(1);

    let attestor = venue.attestor.insecure_clone();
    let payer = venue.authority.insecure_clone();
    let attest = |venue: &mut Venue, halted: bool, since_ts: i64| {
        must_send(
            &mut venue.svm,
            &[ix(
                crate::accounts::AttestHalt {
                    attestor: anchor_key(attestor.pubkey()),
                    registry: venue.registry,
                    security: venue.security,
                },
                crate::instruction::AttestHalt {
                    halted,
                    since_ts,
                    source: 1,
                },
            )],
            &payer,
            &[&attestor],
        );
    };

    // Halted from twenty open minutes into the window...
    venue.at(exercise_ts());
    attest(&mut venue, true, exercise_ts());
    assert!(venue.exercise(1).is_err(), "halted");

    // ...and cleared once the wall clock is past the end of the window.
    venue.at(settled_ts());
    attest(&mut venue, false, 0);
    assert!(
        !venue.security_state().halt.halted,
        "the halt is gone from the gate"
    );

    // The holder still has the minutes the halt took. Twenty-five of the
    // thirty were refused, so the window has ten actionable minutes left.
    venue.at(settled_ts() + 60);
    assert!(
        venue.settle_expired().is_err(),
        "FINDING F-10: the writer settled a window the holder was refused out of"
    );
    venue.exercise(1).expect("the option survived the halt");
    assert_eq!(
        balance_of(&venue.svm, venue.holder_underlying),
        CONTRACT_RAW_SIZE
    );
}

/// The same shape with no privileged key at all: the issuer schedules an
/// ordinary dividend accrual whose effective timestamp lands inside the
/// settlement window. `MULTIPLIER_QUIET_PERIOD_SECS` is 30 minutes and the
/// default window is 30 open minutes, so one routine corporate action covers
/// the whole of it. `create_series` never checks for this.
#[test]
fn a_scheduled_corporate_action_can_swallow_the_whole_window() {
    // Expiry mid-session so the thirty open minutes are also thirty wall
    // minutes: Monday 2026-09-21, 11:00 ET.
    let expiry = et(2026, 9, 21, 11, 0);
    let config = VenueConfig {
        now: et(2026, 9, 21, 10, 0),
        expiry_ts: expiry,
        ..VenueConfig::default()
    };
    let mut venue = Venue::written(config, 1);
    venue.hand_option_to_holder(1);

    // A change scheduled to take effect at the end of the window.
    set_mint_multiplier(&mut venue.svm, 1.01, expiry + 30 * 60);

    for offset in [1i64, 10 * 60, 29 * 60] {
        venue.at(expiry + offset);
        let refused = venue
            .exercise(1)
            .expect_err("the quiet period covers the window");
        assert_eq!(
            refusal_code_in_logs(&refused.meta.logs),
            Some(RefusalCode::MultiplierPending as u8),
            "at +{offset}s"
        );
    }

    // Thirty open minutes later the window is spent and the change is live.
    venue.at(expiry + 31 * 60);
    assert!(
        venue.exercise(1).is_ok(),
        "FINDING F-10: every minute of the settlement window was refused for a \
         routine scheduled dividend, and the window is now closed"
    );
}

// ---------------------------------------------------------------------------
// F-11 — `settle_expired` accepts any calendar
// ---------------------------------------------------------------------------
//
// Every other instruction that takes a calendar also asserts
// `calendar.id == security.calendar_id` (instructions/mod.rs:94, series.rs:42,
// write.rs:46, settle.rs:43, security.rs:235). `SettleExpired` carries no
// `security` account at all and therefore cannot make that check — yet it is
// the calendar it is handed that decides, via `open_minutes_between`, whether
// the exercise window has run out.

/// A writer picks the calendar that says their window is already over, takes
/// the collateral back before any holder can exercise, and leaves the holder
/// holding an option against an empty vault.
#[test]
fn a_writer_settles_early_by_handing_in_a_different_calendar() {
    let mut venue = Venue::written(VenueConfig::default(), 1);
    venue.hand_option_to_holder(1);

    // A second calendar exists — which is what `MarketCalendar::id` is for.
    // Round-the-clock hours, no holidays.
    let other = Pubkey::find_program_address(
        &[crate::constants::CALENDAR_SEED, &1u16.to_le_bytes()],
        &crate::ID,
    )
    .0;
    let authority = venue.authority.insecure_clone();
    must_send(
        &mut venue.svm,
        &[ix(
            crate::accounts::InitCalendar {
                authority: anchor_key(authority.pubkey()),
                registry: venue.registry,
                calendar: other,
                system_program: anchor_lang::system_program::ID,
            },
            crate::instruction::InitCalendar {
                id: 1,
                regular_open_minute: 0,
                regular_close_minute: 24 * 60,
            },
        )],
        &authority,
        &[],
    );

    // Sunday: the real window has spent ten of its thirty open minutes and
    // the other twenty are Monday's. Nobody may exercise yet.
    venue.at(super::venue::HERO_TS);

    let instruction = ix(
        crate::accounts::SettleExpired {
            writer: anchor_key(venue.writer.pubkey()),
            security: venue.security,
            calendar: other,
            series: venue.series,
            position: venue.position,
            underlying_mint: venue.underlying(),
            quote_mint: venue.quote(),
            collateral_vault: venue.collateral_vault,
            quote_vault: venue.quote_vault,
            writer_underlying: anchor_key(venue.writer_underlying),
            writer_quote: anchor_key(venue.writer_quote),
            underlying_token_program: anchor_key(TOKEN_2022),
            quote_token_program: anchor_key(TOKEN_LEGACY),
        },
        crate::instruction::SettleExpired {},
    );
    let writer = venue.writer.insecure_clone();
    let early = send(&mut venue.svm, &[instruction], &writer, &[]);

    assert!(
        early.is_err(),
        "FINDING F-11: the writer settled on a foreign calendar while the real \
         window was still open; the collateral vault now holds {} and the \
         holder's exercise on Monday fails",
        balance_of(&venue.svm, svm_key_of(venue.collateral_vault))
    );
}
