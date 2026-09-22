//! Deliverable — options on tokenized US stocks that survive corporate actions
//! and the closing bell.
//!
//! Two namespaces in one program. The *rail* publishes what is true about a
//! tokenized security: session computed on-chain from a committed exchange
//! calendar, price normalised from a pluggable oracle, halt attested, and the
//! Token-2022 `ScaledUiAmount` multiplier read straight off the mint. The
//! *venue* writes European, physically-settled contracts against it.
//!
//! One program rather than two: deploy rent is paid per program and the rail is
//! consumed by reading accounts, not by CPI, so splitting would cost real money
//! and buy nothing.

pub mod calendar;
pub mod constants;
pub mod error;
pub mod fixed;
pub mod gate;
pub mod instructions;
pub mod mint_guards;
pub mod oracle;
pub mod scaled_ui;
pub mod state;

#[cfg(test)]
mod tests;

use anchor_lang::prelude::*;

pub use constants::*;
pub use error::*;
pub use oracle::{OracleBinding, OracleSource};
pub use state::*;

// Not a re-export: `#[program]` publishes an entry point per instruction under
// the same name as the handler it calls, so re-exporting the handlers too would
// make `crate::write` ambiguous. The accounts structs and the generated client
// modules still have to be reachable from the crate root, which this does.
use instructions::*;

declare_id!("DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa");

#[program]
pub mod deliverable {
    use super::*;

    // --- the rail ---

    pub fn init_registry(ctx: Context<InitRegistry>, attestor: Pubkey) -> Result<()> {
        instructions::admin::init_registry(ctx, attestor)
    }

    pub fn set_registry_paused(ctx: Context<SetRegistryPaused>, paused: bool) -> Result<()> {
        instructions::admin::set_registry_paused(ctx, paused)
    }

    pub fn init_calendar(
        ctx: Context<InitCalendar>,
        id: u16,
        regular_open_minute: u16,
        regular_close_minute: u16,
    ) -> Result<()> {
        instructions::admin::init_calendar(ctx, id, regular_open_minute, regular_close_minute)
    }

    pub fn append_calendar_entries(
        ctx: Context<AppendCalendarEntries>,
        entries: Vec<CalendarEntry>,
    ) -> Result<()> {
        instructions::admin::append_calendar_entries(ctx, entries)
    }

    pub fn register_security(
        ctx: Context<RegisterSecurity>,
        symbol: [u8; 12],
        sources: OracleBinding,
        max_price_age: u32,
        max_conf_bps: u32,
        max_divergence_bps: u32,
    ) -> Result<()> {
        instructions::security::register_security(
            ctx,
            symbol,
            sources,
            max_price_age,
            max_conf_bps,
            max_divergence_bps,
        )
    }

    pub fn sync_security(ctx: Context<ReadSecurity>) -> Result<()> {
        instructions::security::sync_security(ctx)
    }

    pub fn attest_halt(
        ctx: Context<AttestHalt>,
        halted: bool,
        since_ts: i64,
        source: u8,
    ) -> Result<()> {
        instructions::security::attest_halt(ctx, halted, since_ts, source)
    }

    /// Ask the gate for its verdict and record it. Succeeds either way, which
    /// is the only way a refusal can be counted — every other caller reverts.
    pub fn probe_security(ctx: Context<ProbeSecurity>) -> Result<()> {
        instructions::security::probe_security(ctx)
    }

    /// Session resolution for a calendar, as a transaction anyone can send. The
    /// answer is free to compute off-chain from the same account, but having it
    /// on-chain means a refusal can be pointed at rather than argued about.
    pub fn probe_session(ctx: Context<ProbeSession>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let session = calendar::resolve_session(&ctx.accounts.calendar, now);
        msg!("session={:?} at={}", session, now);
        Ok(())
    }

    // --- the venue ---

    pub fn create_series(
        ctx: Context<CreateSeries>,
        expiry_ts: i64,
        strike0: u64,
        kind: OptionKind,
        contract_raw_size: u64,
        settlement_window_minutes: u16,
        adjust_on_corporate_action: bool,
    ) -> Result<()> {
        instructions::series::create_series(
            ctx,
            expiry_ts,
            strike0,
            kind,
            contract_raw_size,
            settlement_window_minutes,
            adjust_on_corporate_action,
        )
    }

    pub fn acknowledge_adjustment(ctx: Context<AcknowledgeAdjustment>) -> Result<()> {
        instructions::series::acknowledge_adjustment(ctx)
    }

    pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
        instructions::write::open_position(ctx)
    }

    pub fn write<'info>(
        ctx: Context<'info, Write<'info>>,
        contracts: u64,
    ) -> Result<()> {
        instructions::write::write(ctx, contracts)
    }

    pub fn claim_premium<'info>(
        ctx: Context<'info, ClaimPremium<'info>>,
    ) -> Result<()> {
        instructions::write::claim_premium(ctx)
    }

    pub fn exercise<'info>(
        ctx: Context<'info, Exercise<'info>>,
        contracts: u64,
    ) -> Result<()> {
        instructions::settle::exercise(ctx, contracts)
    }

    pub fn settle_expired<'info>(
        ctx: Context<'info, SettleExpired<'info>>,
    ) -> Result<()> {
        instructions::settle::settle_expired(ctx)
    }
}

#[derive(Accounts)]
pub struct ProbeSession<'info> {
    pub calendar: Account<'info, MarketCalendar>,
}
