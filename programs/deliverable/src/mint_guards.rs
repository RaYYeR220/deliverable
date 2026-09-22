//! What the issuer can still do to a mint we hold collateral in.
//!
//! Two Token-2022 extensions on every xStock are levers held by the issuer
//! rather than by the market: `Pausable`, which stops transfers outright, and
//! `TransferHook`, whose `programId` is null today on all 100 of them while the
//! authority that can fill it is live. Filling it means arbitrary code runs
//! inside every transfer, including ours.
//!
//! Both are read off the mint in the same transaction that would move tokens,
//! because a cached answer to "can this token still move" is worth nothing.

use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::{
    pausable::PausableConfig, transfer_hook::TransferHook,
};
use anchor_spl::token_interface::{get_mint_extension_data, Mint};

/// The issuer-controlled state of a mint at one instant.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MintGuards {
    pub paused: bool,
    /// `transferHook.programId`, once it stops being null.
    pub transfer_hook: Option<Pubkey>,
}

/// Read both levers off a live mint.
///
/// A mint without either extension is not a mint that can be paused or hooked,
/// so a missing extension is `false`/`None` rather than an error — the absence
/// is the safe answer, and it is the honest one.
pub fn read_mint_guards(mint: &InterfaceAccount<Mint>) -> Result<MintGuards> {
    let info = mint.to_account_info();

    let paused = get_mint_extension_data::<PausableConfig>(&info)
        .map(|cfg| bool::from(cfg.paused))
        .unwrap_or(false);

    let transfer_hook = get_mint_extension_data::<TransferHook>(&info)
        .ok()
        .and_then(|cfg| Option::<Pubkey>::from(cfg.program_id));

    Ok(MintGuards {
        paused,
        transfer_hook,
    })
}
