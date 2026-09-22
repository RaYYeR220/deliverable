//! `create_series` and `acknowledge_adjustment`.
//!
//! A series is canonical: its PDA is derived from the underlying, the expiry,
//! the strike and the kind, so two people cannot list the same contract twice
//! and split its liquidity. Creating it a second time collides, which is the
//! intent rather than an inconvenience.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::calendar::{resolve_session, Session};
use crate::constants::{
    CALENDAR_SEED, MAX_CONTRACTS_PER_SERIES, OPTION_MINT_SEED, PREMIUM_SEED, QUOTE_SEED,
    REGISTRY_SEED, SECURITY_SEED, SERIES_SEED, VAULT_SEED,
};
use crate::error::DeliverableError;
use crate::scaled_ui::read_multiplier;
use crate::state::{
    MarketCalendar, OptionKind, OptionSeries, Registry, SecurityState, SeriesCreated,
    StrikeAdjusted,
};

#[derive(Accounts)]
#[instruction(expiry_ts: i64, strike0: u64, kind: OptionKind)]
pub struct CreateSeries<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        constraint = !registry.paused @ DeliverableError::RegistryPaused,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        seeds = [SECURITY_SEED, underlying_mint.key().as_ref()],
        bump = security.bump,
    )]
    pub security: Box<Account<'info, SecurityState>>,
    #[account(
        seeds = [CALENDAR_SEED, &calendar.id.to_le_bytes()],
        bump = calendar.bump,
        constraint = calendar.id == security.calendar_id @ DeliverableError::CalendarMismatch,
    )]
    pub calendar: Box<Account<'info, MarketCalendar>>,
    #[account(address = security.underlying_mint @ DeliverableError::MintMismatch)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    /// What exercise is paid in. Not hardcoded: the quote asset is a listing
    /// decision, and a venue that bakes one in cannot list against anything
    /// else without a redeploy.
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        init,
        payer = creator,
        space = 8 + OptionSeries::INIT_SPACE,
        seeds = [
            SERIES_SEED,
            underlying_mint.key().as_ref(),
            &expiry_ts.to_le_bytes(),
            &strike0.to_le_bytes(),
            &[kind as u8],
        ],
        bump,
    )]
    pub series: Box<Account<'info, OptionSeries>>,

    /// One option token is one contract, so it has no decimals to round.
    #[account(
        init,
        payer = creator,
        seeds = [OPTION_MINT_SEED, series.key().as_ref()],
        bump,
        mint::decimals = 0,
        mint::authority = series,
        mint::token_program = underlying_token_program,
    )]
    pub option_mint: Box<InterfaceAccount<'info, Mint>>,

    /// Anchor sizes this from the mint's own required account extensions, which
    /// is how the 175-byte xStock token account gets allocated correctly
    /// without the program knowing that number.
    #[account(
        init,
        payer = creator,
        seeds = [VAULT_SEED, series.key().as_ref()],
        bump,
        token::mint = underlying_mint,
        token::authority = series,
        token::token_program = underlying_token_program,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = creator,
        seeds = [PREMIUM_SEED, series.key().as_ref()],
        bump,
        token::mint = underlying_mint,
        token::authority = series,
        token::token_program = underlying_token_program,
    )]
    pub premium_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = creator,
        seeds = [QUOTE_SEED, series.key().as_ref()],
        bump,
        token::mint = quote_mint,
        token::authority = series,
        token::token_program = quote_token_program,
    )]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    pub underlying_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[allow(clippy::too_many_arguments)]
pub fn create_series(
    ctx: Context<CreateSeries>,
    expiry_ts: i64,
    strike0: u64,
    kind: OptionKind,
    contract_raw_size: u64,
    settlement_window_minutes: u16,
    adjust_on_corporate_action: bool,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // Covered calls are the spine of this venue. A cash-secured put escrows the
    // quote asset instead of the share and assigns in the other direction; it
    // is the symmetric case, and half of it would be worse than none.
    require!(kind == OptionKind::Call, DeliverableError::PutsNotSupported);
    require!(strike0 > 0, DeliverableError::ZeroAmount);
    require!(contract_raw_size > 0, DeliverableError::ZeroAmount);
    require!(settlement_window_minutes > 0, DeliverableError::ZeroAmount);
    require!(expiry_ts > now, DeliverableError::ExpiryInThePast);
    // A contract that expires when the market is shut expires against a price
    // nobody can defend. The calendar already knows; refusing at listing is
    // cheaper than discovering it at settlement.
    require!(
        resolve_session(&ctx.accounts.calendar, expiry_ts) == Session::Regular,
        DeliverableError::ExpiryNotInSession
    );
    require!(
        contract_raw_size
            .checked_mul(MAX_CONTRACTS_PER_SERIES)
            .is_some(),
        DeliverableError::MathOverflow
    );

    let multiplier = read_multiplier(&ctx.accounts.underlying_mint, now)?;

    let series = &mut ctx.accounts.series;
    series.security = ctx.accounts.security.key();
    series.underlying_mint = ctx.accounts.underlying_mint.key();
    series.quote_mint = ctx.accounts.quote_mint.key();
    series.option_mint = ctx.accounts.option_mint.key();
    series.collateral_vault = ctx.accounts.collateral_vault.key();
    series.premium_vault = ctx.accounts.premium_vault.key();
    series.quote_vault = ctx.accounts.quote_vault.key();
    series.creator = ctx.accounts.creator.key();
    series.kind = kind;
    series.expiry_ts = expiry_ts;
    series.strike0 = strike0;
    series.multiplier_at_mint = multiplier.effective;
    series.contract_raw_size = contract_raw_size;
    series.settlement_window_minutes = settlement_window_minutes;
    series.adjust_on_corporate_action = adjust_on_corporate_action;
    series.underlying_decimals = ctx.accounts.underlying_mint.decimals;
    series.quote_decimals = ctx.accounts.quote_mint.decimals;
    series.bump = ctx.bumps.series;
    series.contracts_written = 0;
    series.contracts_exercised = 0;
    series.quote_collected = 0;
    series.premium_claimed_total = 0;
    series.window_opened_ts = 0;
    series.acknowledged_multiplier = multiplier.effective;

    emit!(SeriesCreated {
        series: series.key(),
        security: series.security,
        underlying_mint: series.underlying_mint,
        expiry_ts,
        strike0,
        contract_raw_size,
        multiplier_at_mint: multiplier.effective,
        adjust_on_corporate_action,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AcknowledgeAdjustment<'info> {
    #[account(mut)]
    pub series: Box<Account<'info, OptionSeries>>,
    #[account(address = series.underlying_mint @ DeliverableError::MintMismatch)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
}

/// Publish the re-cut.
///
/// Nothing depends on this. The strike is derived from the mint inside every
/// instruction that uses it, so a missed acknowledgement cannot corrupt a
/// contract — it can only leave an indexer showing yesterday's number. That is
/// the whole reason the instruction is allowed to be permissionless and
/// optional.
pub fn acknowledge_adjustment(ctx: Context<AcknowledgeAdjustment>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let multiplier = read_multiplier(&ctx.accounts.underlying_mint, now)?;
    let series = &mut ctx.accounts.series;

    let old_multiplier = series.acknowledged_multiplier;
    let old_strike = series.current_strike(old_multiplier)?;
    let new_strike = series.current_strike(multiplier.effective)?;
    series.acknowledged_multiplier = multiplier.effective;

    emit!(StrikeAdjusted {
        series: series.key(),
        old_strike,
        new_strike,
        old_multiplier,
        new_multiplier: multiplier.effective,
        at: now,
    });
    Ok(())
}
