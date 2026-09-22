//! A series of European, physically-settled contracts on one security.
//!
//! The strike is never stored adjusted. It is derived from the mint's own
//! `ScaledUiAmount` multiplier at the moment it is used, in the same
//! transaction, so a corporate action cannot be missed by failing to send a
//! transaction — there is no transaction to miss. `acknowledge_adjustment`
//! exists only to put a `StrikeAdjusted` event on the wire for indexers.

use anchor_lang::prelude::*;

use crate::calendar::open_minutes_between;
use crate::constants::{MAX_MULTIPLIER_BAND, SCALE};
use crate::error::DeliverableError;
use crate::fixed::{mul_div_ceil, mul_div_floor};
use crate::gate::HaltState;
use crate::scaled_ui::MintMultiplier;
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

    /// Contracts already assigned to writers who have settled.
    ///
    /// Assignment has to sum to exactly `contracts_exercised`: pro rata over
    /// integers rounds *every* writer down, so the writers collectively reclaim
    /// more raw collateral than the vault holds and whoever settles after it
    /// dries takes the loss. The running total is what makes the sum exact.
    pub contracts_assigned_total: u64,

    /// Premium accrued per contract since the series was listed, scaled by
    /// [`SCALE`], monotonic.
    ///
    /// Premium is time-weighted rather than split by the book as it stands at
    /// claim time: an accumulator that only ever moves forward, credited before
    /// `contracts_written` changes, means a writer can claim exactly the
    /// premium that arrived while their contracts were outstanding and nothing
    /// else. Splitting by the instantaneous book let a writer who arrived after
    /// the premium did take a share of it, in the same transaction that opened
    /// their position.
    pub premium_per_contract_acc: u128,
    /// Premium already folded into the accumulator. The difference between this
    /// and the live pool is what the next accrual credits, so the remainder
    /// integer division leaves behind rolls forward instead of stranding.
    pub premium_credited_total: u64,
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
        // Never zero. Nothing else stopped a large enough multiplier from
        // flooring the re-cut strike to nothing, and `exercise_cost` multiplies
        // by it, so the holder took physical delivery of a real share for free.
        // One quote unit is not a defensible price either — which is why
        // `require_multiplier_in_band` refuses long before it gets here — but a
        // floor of one is the difference between charging too little and
        // charging nothing at all.
        let v = v.max(1);
        u64::try_from(v).map_err(|_| DeliverableError::MathOverflow.into())
    }

    /// A contract covers a fixed *raw* amount; its UI size — what a human calls
    /// "how many shares" — scales with the multiplier.
    pub fn current_ui_size(&self, m1: u128) -> Result<u128> {
        // The mirror of the strike floor: a large enough reverse split rounds
        // the UI size to zero and delivery becomes free from the other side.
        Ok(mul_div_floor(self.contract_raw_size as u128, m1, SCALE)?.max(1))
    }

    /// Refuse to re-cut the strike at all once the multiplier has moved further
    /// than any corporate action ever has.
    ///
    /// The program has no authority over the mint's `ScaledUiAmount` value and
    /// no way to tell a split from a dividend from a hostile write. What it can
    /// do is decline to price a contract against a number that cannot be a
    /// corporate action: the largest real xStock multipliers are KLACX at
    /// 10.016833 and VUGX at 6.004668, so a thousandfold band in either
    /// direction admits every one of them and refuses the case where the issuer
    /// converts an open call into a free claim on collateral still worth full
    /// value.
    pub fn require_multiplier_in_band(&self, m1: u128) -> Result<()> {
        if !self.adjust_on_corporate_action {
            return Ok(());
        }
        require!(m1 > 0, DeliverableError::InvalidMultiplier);
        let m0 = self.multiplier_at_mint;
        require!(m0 > 0, DeliverableError::InvalidMultiplier);
        let within = m1
            <= m0
                .checked_mul(MAX_MULTIPLIER_BAND)
                .ok_or(DeliverableError::MathOverflow)?
            && m1
                .checked_mul(MAX_MULTIPLIER_BAND)
                .ok_or(DeliverableError::MathOverflow)?
                >= m0;
        require!(within, DeliverableError::MultiplierOutOfBand);
        Ok(())
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

    /// Open-market minutes inside this series' window during which the venue
    /// was provably refusing to act on the security.
    ///
    /// `open_minutes_between` stops for a closed market — the case the design
    /// was built around — and for nothing else. A refusal that spans the
    /// settlement window is therefore not a delay but a total loss for every
    /// in-the-money holder and a windfall for the writers, and there is no
    /// re-open anywhere. So the clock has to measure *actionable* minutes.
    ///
    /// Only refusals that leave a durable, retrospective record can be
    /// subtracted, because the instruction that hit them reverted and took its
    /// own record with it. Two do: an attested halt carries its `since_ts` and
    /// keeps it after being lifted, and Token-2022 keeps a multiplier change's
    /// effective timestamp on the mint after the change lands. Both are read
    /// from accounts the caller cannot choose.
    pub fn refused_window_minutes(
        &self,
        cal: &MarketCalendar,
        halt: &HaltState,
        multiplier: &MintMultiplier,
        now: i64,
    ) -> u32 {
        let mut refused: u32 = 0;
        for interval in [halt.refused_interval(now), multiplier.quiet_interval()]
            .into_iter()
            .flatten()
        {
            let (from, until) = interval;
            // Clip to the part of the refusal that fell inside this window, and
            // never credit time the series itself has proof the venue was
            // acting in: `window_opened_ts` is stamped by the first exercise
            // the gate let through after expiry, and a refusal cannot have been
            // in force at an instant an exercise succeeded. That also bounds
            // what a `since_ts` backdated by the attestor can buy.
            let from = from.max(self.expiry_ts).max(self.window_opened_ts);
            let until = until.min(now);
            refused = refused.saturating_add(open_minutes_between(cal, from, until));
        }
        refused
    }

    pub fn phase(&self, cal: &MarketCalendar, now: i64) -> SeriesPhase {
        self.phase_with_refusals(cal, now, 0)
    }

    /// The phase, with `refused_minutes` of the window given back.
    ///
    /// A refusal postpones settlement rather than cancelling the option — but
    /// not indefinitely. Past [`MAX_SESSION_SCAN_DAYS`] the session accumulator
    /// saturates and the window is spent whatever happened inside it, because
    /// the alternative is that a refusal nobody ever lifts freezes the writers'
    /// collateral permanently. That is the symmetric hazard, and it is the one
    /// the deliberate decision to leave `settle_expired` ungated was protecting
    /// against; the bound keeps both halves bounded instead of picking a side.
    pub fn phase_with_refusals(
        &self,
        cal: &MarketCalendar,
        now: i64,
        refused_minutes: u32,
    ) -> SeriesPhase {
        if now < self.expiry_ts {
            return SeriesPhase::Active;
        }
        let elapsed = self.elapsed_session_minutes(cal, now);
        if elapsed == u32::MAX {
            return SeriesPhase::Settled;
        }
        if elapsed.saturating_sub(refused_minutes) < self.settlement_window_minutes as u32 {
            SeriesPhase::Settling
        } else {
            SeriesPhase::Settled
        }
    }

    /// Credit premium that has arrived since the last accrual to the
    /// accumulator, before anything changes `contracts_written`.
    ///
    /// `pool` is everything the premium vault has ever received: its balance
    /// plus what has already been paid out. The uncredited remainder of the
    /// integer division stays uncredited and is picked up by the next accrual,
    /// so nothing is stranded by rounding.
    pub fn accrue_premium(&mut self, pool: u64) -> Result<()> {
        let delta = pool.saturating_sub(self.premium_credited_total);
        if delta == 0 || self.contracts_written == 0 {
            return Ok(());
        }
        let per_contract = mul_div_floor(
            delta as u128,
            SCALE,
            self.contracts_written as u128,
        )?;
        if per_contract == 0 {
            return Ok(());
        }
        self.premium_per_contract_acc = self
            .premium_per_contract_acc
            .checked_add(per_contract)
            .ok_or(DeliverableError::MathOverflow)?;
        let credited = mul_div_floor(per_contract, self.contracts_written as u128, SCALE)?;
        self.premium_credited_total = self
            .premium_credited_total
            .checked_add(u64::try_from(credited).map_err(|_| DeliverableError::MathOverflow)?)
            .ok_or(DeliverableError::MathOverflow)?;
        Ok(())
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
    /// The accumulator level this position is paid up to, scaled by [`SCALE`].
    ///
    /// Raised on every write, by the accumulator's value at that moment times
    /// the contracts written, so premium that arrived before those contracts
    /// existed is not claimable against them. This is the whole of the
    /// time-weighting: without it, writing one contract a second before expiry
    /// bought a pro-rata share of every premium the series had ever earned.
    pub premium_debt: u128,
}

impl WriterPosition {
    /// This writer's share of assignment, pro rata by contracts written and
    /// rounded down.
    ///
    /// Assignment on a real exchange is a lottery; pro rata is the
    /// deterministic version of the same thing and it is what a program can
    /// defend. The floor alone does **not** conserve — it rounds every writer
    /// down, so the assignments sum to less than what was exercised and the
    /// writers collectively reclaim more collateral than the vault holds. This
    /// is the fair share, not the settled one; [`Self::conserving_assignment`]
    /// is what settlement uses.
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

    /// Contracts assigned to this writer at settlement, such that the
    /// assignments over all writers sum to exactly `contracts_exercised`.
    ///
    /// The writer's pro-rata share rounded **up**, capped by what is left to
    /// assign. Rounding up cannot over-assign a writer — `ceil(c·E/W) <= c`
    /// whenever `E <= W`, which `exercise` enforces — and the cap is what makes
    /// the sum exact: every writer is assigned at least their floor share, the
    /// remainder lands on the earliest settlers rather than on nobody, and the
    /// last settlers are assigned nothing rather than being handed a bill for
    /// collateral that has already left the vault.
    ///
    /// `Σ (contracts − assigned) == contracts_written − contracts_exercised`
    /// exactly, which is the vault's balance, so no writer's return depends on
    /// where they came in the settlement queue.
    pub fn conserving_assignment(&self, series: &OptionSeries) -> Result<u64> {
        if series.contracts_written == 0 || series.contracts_exercised == 0 {
            return Ok(0);
        }
        let share = mul_div_ceil(
            self.contracts as u128,
            series.contracts_exercised as u128,
            series.contracts_written as u128,
        )?;
        let share = u64::try_from(share).map_err(|_| DeliverableError::MathOverflow)?;
        let remaining = series
            .contracts_exercised
            .saturating_sub(series.contracts_assigned_total);
        Ok(share.min(remaining).min(self.contracts))
    }

    /// Premium this position has earned and not yet taken, in raw units.
    pub fn premium_owed(&self, series: &OptionSeries) -> Result<u64> {
        let entitled = mul_div_floor(
            series.premium_per_contract_acc,
            self.contracts as u128,
            SCALE,
        )?;
        let owed = entitled.saturating_sub(self.premium_debt);
        u64::try_from(owed).map_err(|_| DeliverableError::MathOverflow.into())
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
    /// Raw units this writer was owed and the vault could not pay.
    ///
    /// Zero for every ordinary settlement: assignment conserves, so the vault
    /// holds exactly what the unassigned writers are owed. It can only be
    /// non-zero if the underlying left the vault by a route this program does
    /// not control — a permanent-delegate seizure — and in that case it must be
    /// on the wire rather than absorbed silently by whoever settles last.
    pub raw_shortfall: u64,
}

#[event]
pub struct PremiumClaimed {
    pub series: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
}
