//! The corporate-action feed, such as it is.
//!
//! There is no on-chain corporate-action source for tokenized equities. The
//! only signal is the Token-2022 `ScaledUiAmount` multiplier on the mint —
//! unlabelled, set by a single keypair, emitting no event. A split and a
//! dividend are the same write with different magnitudes, which is exactly why
//! we never have to classify them.
//!
//! `ScaledUiAmountConfig::current_multiplier` and `total_multiplier` are
//! private in spl-token-2022-interface, and the public `amount_to_ui_amount`
//! goes through `format!`, so neither is usable from a program. The selection
//! rule is re-implemented here against the decoded fixed-point value.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    scaled_ui_amount::ScaledUiAmountConfig, BaseStateWithExtensions, PodStateWithExtensions,
};
use anchor_spl::token_2022::spl_token_2022::pod::PodMint;
use anchor_spl::token_interface::{get_mint_extension_data, Mint};

use crate::error::DeliverableError;
use crate::fixed::f64_bits_to_fixed;

/// What the mint says about its own multiplier at a given instant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MintMultiplier {
    /// In force now, fixed-point 1e12.
    pub effective: u128,
    /// A scheduled change that has not taken effect: `(multiplier, effective_ts)`.
    pub pending: Option<(u128, i64)>,
    /// Changes exactly when the effective multiplier changes, so a series can
    /// detect that an adjustment has occurred without storing the value twice.
    pub epoch_key: i64,
}

/// Read the effective multiplier off a live Token-2022 mint account.
///
/// Called inline wherever the multiplier matters, so nothing can be stale: the
/// mint is the source of truth in the same transaction that uses it.
pub fn read_multiplier(mint: &InterfaceAccount<Mint>, now: i64) -> Result<MintMultiplier> {
    let info = mint.to_account_info();
    let cfg = get_mint_extension_data::<ScaledUiAmountConfig>(&info)
        .map_err(|_| error!(DeliverableError::MissingScaledUiAmount))?;
    effective_from_cfg(&cfg, now)
}

/// Pull the `ScaledUiAmount` extension out of raw mint account bytes.
///
/// Separate from [`read_multiplier`] so tests can run against a dumped mainnet
/// mint without standing up an `AccountInfo`.
pub fn parse_scaled_ui(mint_data: &[u8]) -> Result<ScaledUiAmountConfig> {
    let state = PodStateWithExtensions::<PodMint>::unpack(mint_data)
        .map_err(|_| error!(DeliverableError::MissingScaledUiAmount))?;
    state
        .get_extension::<ScaledUiAmountConfig>()
        .copied()
        .map_err(|_| error!(DeliverableError::MissingScaledUiAmount))
}

/// Apply the extension's own rule: `new_multiplier` takes over at
/// `new_multiplier_effective_timestamp`, inclusive.
pub fn effective_from_cfg(cfg: &ScaledUiAmountConfig, now: i64) -> Result<MintMultiplier> {
    let old = f64_bits_to_fixed(u64::from_le_bytes(cfg.multiplier.0))?;
    let new = f64_bits_to_fixed(u64::from_le_bytes(cfg.new_multiplier.0))?;
    let effective_ts: i64 = cfg.new_multiplier_effective_timestamp.into();

    if now >= effective_ts {
        Ok(MintMultiplier {
            effective: new,
            pending: None,
            epoch_key: effective_ts,
        })
    } else {
        Ok(MintMultiplier {
            effective: old,
            pending: Some((new, effective_ts)),
            epoch_key: 0,
        })
    }
}
