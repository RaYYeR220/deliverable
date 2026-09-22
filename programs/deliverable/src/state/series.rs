//! A series of European, physically-settled contracts on one security.
//!
//! The strike is never stored adjusted. It is derived from the mint's own
//! `ScaledUiAmount` multiplier at the moment it is used, in the same
//! transaction, so a corporate action cannot be missed by failing to send a
//! transaction — there is no transaction to miss. `acknowledge_adjustment`
//! exists only to put a `StrikeAdjusted` event on the wire for indexers.

use anchor_lang::prelude::*;

use crate::calendar::open_minutes_between;
use crate::constants::SCALE;
use crate::error::DeliverableError;
use crate::fixed::{mul_div_ceil, mul_div_floor};
use crate::state::MarketCalendar;

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OptionKind {
    Call,
    /// Cash-secured puts are the symmetric case and are not built. The variant
    /// exists because the PDA seed and the SDK type are shaped around it;
    /// `create_series` rejects it rather than half-implementing settlement.
    Put,
}

/// Where a series is in its life. Derived from the clock and the calendar every
/// time it is asked rather than stored, because a stored phase is wrong from
/// expiry until somebody pays to transition it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SeriesPhase {
    Active,
    Settling,
    Settled,
}

#[account]
#[derive(InitSpace)]
pub struct OptionSeries {
    pub security: Pubkey,
    pub underlying_mint: Pubkey,
    pub quote_mint: Pubkey,
    /// Minted 1:1 with contracts, zero decimals. Burned on exercise.
    pub option_mint: Pubkey,
    /// Holds the raw underlying that backs every written contract.
    pub collateral_vault: Pubkey,
    /// Premium, denominated in the underlying share. A covered call written
    /// here accumulates the share itself.
    pub premium_vault: Pubkey,
    /// Exercise proceeds, in the quote asset.
    pub quote_vault: Pubkey,
    pub creator: Pubkey,

    pub kind: OptionKind,
    /// Validated at creation to land inside a regular session.
    pub expiry_ts: i64,
    /// Quote units per UI unit — per adjusted share — at creation.
    pub strike0: u64,
    /// The mint's effective multiplier when the series was created. Immutable:
    /// it is half of the invariant.
    pub multiplier_at_mint: u128,
    /// Raw units of the underlying one contract covers. Immutable, and raw
    /// rather than UI precisely so a split cannot change what is delivered.
    pub contract_raw_size: u64,
    /// Length of the exercise window, in minutes of open-market time.
    pub settlement_window_minutes: u16,
    /// False writes an unadjusted series: the strike ignores the mint. Every
    /// options venue on tokenized equities today writes one of these by
    /// omission. Being able to express it is what makes the invariant
    /// falsifiable instead of merely asserted.
    pub adjust_on_corporate_action: bool,
    pub underlying_decimals: u8,
    pub quote_decimals: u8,
    pub bump: u8,

    // --- the book ---
    pub contracts_written: u64,
    pub contracts_exercised: u64,
    /// Quote units taken in by exercises, before writers claim them.
    pub quote_collected: u64,
    /// Premium already paid out, so a later claimant sees the same denominator.
    pub premium_claimed_total: u64,
    /// First instant after expiry at which the gate allowed an exercise. Zero
    /// until one does; informational, the window itself is computed.
    pub window_opened_ts: i64,
    /// The multiplier the last `acknowledge_adjustment` reported.
    pub acknowledged_multiplier: u128,
}

impl OptionSeries {
    /// The strike is quoted per UI unit, so it re-cuts inversely with the
    /// multiplier: `strike = strike0 * m0 / m1`.
    ///
    /// Rounds down, against the writer — the party the venue holds collateral
    /// from and therefore the party it must not favour.
    pub fn current_strike(&self, m1: u128) -> Result<u64> {
        if !self.adjust_on_corporate_action {
            return Ok(self.strike0);
        }
        let v = mul_div_floor(self.strike0 as u128, self.multiplier_at_mint, m1)?;
        u64::try_from(v).map_err(|_| DeliverableError::MathOverflow.into())
    }

    /// A contract covers a fixed *raw* amount; its UI size — what a human calls
    /// "how many shares" — scales with the multiplier.
    pub fn current_ui_size(&self, m1: u128) -> Result<u128> {
        mul_div_floor(self.contract_raw_size as u128, m1, SCALE)
    }

    /// What the holder pays, in quote units, to exercise `contracts`.
    ///
    /// `strike x ui_size` is the invariant notional; dividing by the
    /// underlying's decimals brings the UI size off the raw grid. Rounds up, so
    /// integer division can never let a holder take delivery for less than the
    /// strike.
    pub fn exercise_cost(&self, m1: u128, contracts: u64) -> Result<u64> {
        let strike = self.current_strike(m1)? as u128;
        let ui_size = self.current_ui_size(m1)?;
        let grid = 10u128
            .checked_pow(self.underlying_decimals as u32)
            .ok_or(DeliverableError::MathOverflow)?;
        let per_contract = mul_div_ceil(strike, ui_size, grid)?;
        let total = per_contract
            .checked_mul(contracts as u128)
            .ok_or(DeliverableError::MathOverflow)?;
        u64::try_from(total).map_err(|_| DeliverableError::MathOverflow.into())
    }

    /// Raw underlying delivered for `contracts`.
    pub fn delivery_raw(&self, contracts: u64) -> Result<u64> {
        contracts
            .checked_mul(self.contract_raw_size)
            .ok_or(DeliverableError::MathOverflow.into())
    }

    /// Open-market minutes elapsed since expiry.
    pub fn elapsed_session_minutes(&self, cal: &MarketCalendar, now: i64) -> u32 {
        open_minutes_between(cal, self.expiry_ts, now)
    }

    pub fn phase(&self, cal: &MarketCalendar, now: i64) -> SeriesPhase {
        if now < self.expiry_ts {
            SeriesPhase::Active
        } else if self.elapsed_session_minutes(cal, now) < self.settlement_window_minutes as u32 {
            SeriesPhase::Settling
        } else {
            SeriesPhase::Settled
        }
    }
}

/// One writer's obligation against a series.
///
/// The receipt is this account rather than a token. A writer's position is a
/// short option plus the collateral standing behind it; minting a transferable
/// receipt would let the obligation be sold away from the collateral backing
/// it, and then the venue would have to chase whoever holds the paper.
#[account]
#[derive(InitSpace)]
pub struct WriterPosition {
    pub owner: Pubkey,
    pub series: Pubkey,
    /// Contracts written, which is also this writer's share of assignment.
    pub contracts: u64,
    /// Raw underlying deposited, always `contracts * contract_raw_size`.
    pub raw_collateral: u64,
    /// Premium already taken, in underlying raw units.
    pub premium_claimed: u64,
    pub settled: bool,
    pub bump: u8,
}

impl WriterPosition {
    /// Contracts assigned to this writer, pro rata by contracts written.
    ///
    /// Assignment on a real exchange is a lottery; pro rata is the
    /// deterministic version of the same thing and it is what a program can
    /// defend. Rounds down, so the sum of assignments never exceeds what was
    /// actually exercised.
    pub fn assigned(&self, series: &OptionSeries) -> Result<u64> {
        if series.contracts_written == 0 {
            return Ok(0);
        }
        let v = mul_div_floor(
            self.contracts as u128,
            series.contracts_exercised as u128,
            series.contracts_written as u128,
        )?;
        u64::try_from(v).map_err(|_| DeliverableError::MathOverflow.into())
    }
}

#[event]
pub struct SeriesCreated {
    pub series: Pubkey,
    pub security: Pubkey,
    pub underlying_mint: Pubkey,
    pub expiry_ts: i64,
    pub strike0: u64,
    pub contract_raw_size: u64,
    pub multiplier_at_mint: u128,
    pub adjust_on_corporate_action: bool,
}

/// Emitted by `acknowledge_adjustment`. Correctness does not depend on this
/// ever being sent; the UI and the indexers do.
#[event]
pub struct StrikeAdjusted {
    pub series: Pubkey,
    pub old_strike: u64,
    pub new_strike: u64,
    pub old_multiplier: u128,
    pub new_multiplier: u128,
    pub at: i64,
}

#[event]
pub struct ContractsWritten {
    pub series: Pubkey,
    pub writer: Pubkey,
    pub contracts: u64,
    pub raw_collateral: u64,
}

#[event]
pub struct Exercised {
    pub series: Pubkey,
    pub holder: Pubkey,
    pub contracts: u64,
    /// The strike actually charged, after the multiplier re-cut.
    pub strike: u64,
    pub quote_paid: u64,
    pub raw_delivered: u64,
    pub at: i64,
}

#[event]
pub struct PositionSettled {
    pub series: Pubkey,
    pub writer: Pubkey,
    pub contracts_assigned: u64,
    pub raw_returned: u64,
    pub quote_paid: u64,
}

#[event]
pub struct PremiumClaimed {
    pub series: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
}
