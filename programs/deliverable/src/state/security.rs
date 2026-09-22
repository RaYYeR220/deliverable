//! What the program knows about one tokenized security.
//!
//! This is the rail: one account per underlying, readable by any program or
//! indexer without a CPI, carrying the four states that a Solana program
//! otherwise cannot tell apart — session, halt, price, and corporate action.
//!
//! Nothing here is authoritative on its own. The multiplier, the pause flag and
//! the transfer hook are copies of what the mint said at the last sync, and
//! every gated action re-reads them from the mint in its own transaction. The
//! copies exist so a reader can see the state without reconstructing it, not so
//! the program can trust them.

use anchor_lang::prelude::*;

use crate::gate::HaltState;
use crate::oracle::{Observation, OracleBinding};

#[account]
#[derive(InitSpace)]
pub struct SecurityState {
    /// The Token-2022 mint this security *is*. Also its PDA seed.
    pub underlying_mint: Pubkey,
    /// ASCII, right-padded with zeroes: "AAPLx".
    pub symbol: [u8; 12],
    /// Which committed exchange calendar gates it.
    pub calendar_id: u16,
    /// Copied from the mint so a reader does not have to unpack it.
    pub decimals: u8,
    pub bump: u8,

    pub sources: OracleBinding,

    // --- last sync, all of it re-derived at use time ---
    /// The multiplier in force at the last sync, fixed-point 1e12.
    pub observed_multiplier: u128,
    /// A scheduled change, or zero when there is none pending.
    pub pending_multiplier: u128,
    pub pending_effective_ts: i64,
    /// Increments whenever `observed_multiplier` moves, so an indexer can count
    /// corporate actions without diffing every sync.
    pub multiplier_epoch: u64,
    pub mint_paused: bool,
    pub transfer_hook: Option<Pubkey>,
    pub primary: Observation,
    pub secondary: Option<Observation>,
    pub synced_ts: i64,

    pub halt: HaltState,

    // --- per-security tolerances ---
    pub max_price_age: u32,
    pub max_conf_bps: u32,
    pub max_divergence_bps: u32,

    // --- refusal ledger ---
    /// Counted by `probe_security`, which is the only path that can record a
    /// refusal: an instruction that refuses reverts, so its own counter goes
    /// with it. The refused transaction's logs carry the `Refused` event.
    pub refusals: u32,
    pub last_refusal_code: u8,
    pub last_refusal_ts: i64,
}

impl SecurityState {
    pub fn symbol_str(&self) -> &str {
        let end = self
            .symbol
            .iter()
            .position(|b| *b == 0)
            .unwrap_or(self.symbol.len());
        core::str::from_utf8(&self.symbol[..end]).unwrap_or("")
    }
}

#[event]
pub struct SecurityRegistered {
    pub security: Pubkey,
    pub underlying_mint: Pubkey,
    pub symbol: [u8; 12],
    pub calendar_id: u16,
    pub multiplier: u128,
}

#[event]
pub struct SecuritySynced {
    pub security: Pubkey,
    pub multiplier: u128,
    pub multiplier_epoch: u64,
    pub price: i64,
    pub expo: i32,
    pub publish_ts: i64,
    pub at: i64,
}

#[event]
pub struct HaltAttested {
    pub security: Pubkey,
    pub halted: bool,
    pub since_ts: i64,
    pub at: i64,
}
