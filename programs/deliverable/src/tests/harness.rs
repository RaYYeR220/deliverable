//! Real mainnet state, and the LiteSVM scaffolding that hosts it.
//!
//! The fixtures are raw `getAccountInfo` dumps. Re-capture any of them with
//! `tsx scripts/fixtures.ts <pubkey> tests/fixtures/<name>.bin`.

use anchor_lang::prelude::*;
use litesvm::LiteSVM;
use solana_account::Account;
use solana_pubkey::Pubkey as SvmPubkey;

/// AAPLx, `XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp`, 678 bytes. Carries
/// permanentDelegate, pausable, defaultAccountState, scaledUiAmount and an
/// initialized-but-null transferHook.
pub const AAPLX_MINT_DATA: &[u8] = include_bytes!("../../../../tests/fixtures/aaplx_mint.bin");

/// Pyth SOL/USD `PriceUpdateV2`, 134 bytes — the length that means `Full`
/// verification. A `Partial` account is 135.
pub const PYTH_UPDATE_DATA: &[u8] =
    include_bytes!("../../../../tests/fixtures/pyth_sol_usd_priceupdatev2.bin");

/// Kamino Scope `OraclePrices`, 28,712 bytes, captured 2026-09-20.
pub const SCOPE_PRICES_DATA: &[u8] = include_bytes!("../../../../tests/fixtures/scope_prices.bin");

/// USDC, 82 bytes, owned by the original SPL Token program. The venue's quote
/// asset is a legacy mint while its collateral is a Token-2022 mint, which is
/// exactly the pairing a real settlement has to handle.
pub const USDC_MINT_DATA: &[u8] = include_bytes!("../../../../tests/fixtures/usdc_mint.bin");

pub const AAPLX_MINT: SvmPubkey = solana_pubkey::pubkey!("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp");
pub const USDC_MINT: SvmPubkey = solana_pubkey::pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const TOKEN_2022: SvmPubkey = solana_pubkey::pubkey!("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
pub const TOKEN_LEGACY: SvmPubkey = solana_pubkey::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const PYTH_UPDATE: SvmPubkey = solana_pubkey::pubkey!("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
pub const PYTH_RECEIVER: SvmPubkey = solana_pubkey::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// AAPLx as captured: multiplier 1.0026642075893797, newMultiplier
/// 1.0032690125398187, effective 1786149000 (2026-08-08T00:30Z).
pub const AAPLX_MULTIPLIER: f64 = 1.0026642075893797;
pub const AAPLX_NEW_MULTIPLIER: f64 = 1.0032690125398187;
pub const AAPLX_EFFECTIVE_TS: i64 = 1_786_149_000;
pub const AAPLX_DECIMALS: u8 = 8;
pub const USDC_DECIMALS: u8 = 6;

/// Scope indices, derived from the live `TokenMetadatas` on 2026-09-22 by
/// walking `OraclePrices -> Configuration -> TokenMetadatas` and reading the
/// 32-byte ASCII name each index carries.
///
/// Scope publishes several entries per name on one account, and two of them are
/// sourced differently. `Checked` is a `CappedFloored` composition bounded by
/// Chainlink — on 2026-09-22 it printed 340.098163 for AAPLx, exactly the
/// ChainlinkX entry at index 258 — while `PythLazer` carries Pyth's own number,
/// 340.670950 at the same moment. Binding both is what lets the gate ask two
/// vendors the same question from one account.
pub const SCOPE_AAPLX_LAZER: u16 = 315; // "PythLazer AAPLx/USD"
pub const SCOPE_AAPLX_CHECKED: u16 = 317; // "Checked AAPLx/USD"
pub const SCOPE_NVDAX_LAZER: u16 = 330; // "PythLazer NVDAx/USD"
pub const SCOPE_NVDAX_CHECKED: u16 = 332; // "Checked NVDAx/USD"

#[allow(dead_code)]
pub fn mint_account() -> Account {
    Account {
        lamports: 647_086_478,
        data: AAPLX_MINT_DATA.to_vec(),
        owner: TOKEN_2022,
        executable: false,
        rent_epoch: u64::MAX,
    }
}

#[allow(dead_code)]
pub fn pyth_update_account() -> Account {
    Account {
        lamports: 1_825_031,
        data: PYTH_UPDATE_DATA.to_vec(),
        owner: PYTH_RECEIVER,
        executable: false,
        rent_epoch: u64::MAX,
    }
}

#[allow(dead_code)]
pub fn scope_prices_account() -> Account {
    Account {
        lamports: 200_726_443,
        data: SCOPE_PRICES_DATA.to_vec(),
        owner: SvmPubkey::from(crate::constants::SCOPE_PROGRAM.to_bytes()),
        executable: false,
        rent_epoch: u64::MAX,
    }
}

/// The same account with every entry's `unix_timestamp` moved to `publish_ts`.
///
/// The prices are untouched — they are the ones captured on 2026-09-20, and
/// they are the finding. Only the publication time moves, which is exactly what
/// Scope itself does every weekend: the timestamp advances every slot while the
/// number underneath it has not changed since Friday's close. Doing it
/// deliberately here is how a test can sit inside an open session at all,
/// because the captured account was necessarily captured while the market was
/// shut, and it leaves the calendar as the only thing between the test and a
/// settlement at a ghost price.
#[allow(dead_code)]
pub fn scope_prices_account_at(publish_ts: i64) -> Account {
    use crate::constants::{SCOPE_ENTRY_SIZE, SCOPE_MAX_ENTRIES, SCOPE_PRICES_OFFSET};

    let mut data = SCOPE_PRICES_DATA.to_vec();
    let stamp = (publish_ts as u64).to_le_bytes();
    for i in 0..SCOPE_MAX_ENTRIES {
        let ts_at = SCOPE_PRICES_OFFSET + i * SCOPE_ENTRY_SIZE + 24;
        // An unmapped slot is all zeroes and must stay that way: the decoder
        // treats a zero price as an empty slot, not as a free asset.
        if data[ts_at..ts_at + 8] == [0u8; 8] {
            continue;
        }
        data[ts_at..ts_at + 8].copy_from_slice(&stamp);
    }
    Account {
        lamports: 200_726_443,
        data,
        owner: SvmPubkey::from(crate::constants::SCOPE_PROGRAM.to_bytes()),
        executable: false,
        rent_epoch: u64::MAX,
    }
}

#[allow(dead_code)]
pub fn usdc_mint_account() -> Account {
    Account {
        lamports: 534_788_257_985,
        data: USDC_MINT_DATA.to_vec(),
        owner: TOKEN_LEGACY,
        executable: false,
        rent_epoch: u64::MAX,
    }
}

/// US Eastern civil time to unix. Two passes: guess with EST, then correct with
/// whatever offset actually applies at that instant.
#[allow(dead_code)]
pub fn et(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
    use crate::calendar::{days_from_civil, eastern_offset_seconds};
    let local =
        days_from_civil(year, month, day) * 86_400 + hour as i64 * 3600 + minute as i64 * 60;
    local - eastern_offset_seconds(local + 5 * 3600)
}

/// A LiteSVM with the real accounts already loaded and the clock parked at
/// `now`.
#[allow(dead_code)]
pub fn svm_with_real_accounts(now: i64) -> LiteSVM {
    let mut svm = LiteSVM::new();
    svm.set_account(AAPLX_MINT, mint_account()).unwrap();
    svm.set_account(PYTH_UPDATE, pyth_update_account()).unwrap();
    svm.set_account(
        SvmPubkey::from(crate::constants::SCOPE_PRICES.to_bytes()),
        scope_prices_account(),
    )
    .unwrap();

    let mut clock: Clock = svm.get_sysvar();
    clock.unix_timestamp = now;
    svm.set_sysvar(&clock);
    svm
}

/// Build an `AccountInfo` over owned buffers, for exercising a read path that
/// takes one without standing up a whole transaction.
#[allow(dead_code)]
pub fn account_info<'a>(
    key: &'a Pubkey,
    owner: &'a Pubkey,
    lamports: &'a mut u64,
    data: &'a mut [u8],
) -> AccountInfo<'a> {
    AccountInfo::new(key, false, false, lamports, data, owner, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_spl::token_2022::spl_token_2022::{
        extension::{scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions, PodStateWithExtensions},
        pod::PodMint,
    };

    /// The fixtures are the real accounts, not something shaped like them.
    #[test]
    fn fixtures_are_the_real_mainnet_accounts() {
        assert_eq!(AAPLX_MINT_DATA.len(), 678);
        assert_eq!(PYTH_UPDATE_DATA.len(), 134, "134 bytes means Full verification");
        assert_eq!(SCOPE_PRICES_DATA.len(), 28_712);
    }

    /// LiteSVM's accounts db round-trips an extension-laden Token-2022 mint,
    /// and the Token-2022 program is present as a real BPF program.
    #[test]
    fn litesvm_hosts_the_real_token2022_mint() {
        let svm = svm_with_real_accounts(1_789_895_700);

        let t22 = svm.get_account(&TOKEN_2022).expect("token-2022 missing");
        assert!(t22.executable, "token-2022 is not executable in LiteSVM");

        let stored = svm.get_account(&AAPLX_MINT).unwrap();
        assert_eq!(stored.data.len(), 678);
        let state = PodStateWithExtensions::<PodMint>::unpack(&stored.data).unwrap();
        assert_eq!(state.base.decimals, 8);
        let cfg = state.get_extension::<ScaledUiAmountConfig>().unwrap();
        let m: f64 = cfg.multiplier.into();
        assert_eq!(m, AAPLX_MULTIPLIER);
    }

    #[test]
    fn litesvm_hosts_the_real_scope_and_pyth_accounts() {
        let svm = svm_with_real_accounts(1_789_895_700);
        let scope = svm
            .get_account(&SvmPubkey::from(crate::constants::SCOPE_PRICES.to_bytes()))
            .unwrap();
        assert_eq!(scope.data.len(), 28_712);
        assert_eq!(scope.owner.to_bytes(), crate::constants::SCOPE_PROGRAM.to_bytes());

        let pyth = svm.get_account(&PYTH_UPDATE).unwrap();
        assert_eq!(pyth.data.len(), 134);
        assert_eq!(pyth.owner, PYTH_RECEIVER);

        let clock: Clock = svm.get_sysvar();
        assert_eq!(clock.unix_timestamp, 1_789_895_700);
    }
}
