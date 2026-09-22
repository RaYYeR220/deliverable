//! `write` — deposit the share, take on the obligation.
//!
//! A covered call here is fully collateralised in the underlying, in raw units.
//! Raw is the load-bearing word: a contract covers a fixed raw amount, so a
//! ten-for-one split multiplies what the holder receives and divides the strike
//! without a single token moving in or out of the vault.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{
    mint_to, Mint, MintTo, TokenAccount, TokenInterface,
};

use crate::constants::{
    CALENDAR_SEED, MAX_CONTRACTS_PER_SERIES, PREMIUM_SEED, REGISTRY_SEED, SECURITY_SEED,
    SERIES_SEED, WRITER_SEED,
};
use crate::error::DeliverableError;
use crate::fixed::mul_div_floor;
use crate::instructions::{
    assert_security_actionable, transfer_checked_forwarding, SeriesSigner,
};
use crate::state::{
    ContractsWritten, MarketCalendar, OptionSeries, PremiumClaimed, Registry, SecurityState,
    SeriesPhase, WriterPosition,
};

#[derive(Accounts)]
pub struct Write<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        constraint = !registry.paused @ DeliverableError::RegistryPaused,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        seeds = [SECURITY_SEED, underlying_mint.key().as_ref()],
        bump = security.bump,
        constraint = security.key() == series.security @ DeliverableError::SecurityMismatch,
    )]
    pub security: Box<Account<'info, SecurityState>>,
    #[account(
        seeds = [CALENDAR_SEED, &calendar.id.to_le_bytes()],
        bump = calendar.bump,
        constraint = calendar.id == security.calendar_id @ DeliverableError::CalendarMismatch,
    )]
    pub calendar: Box<Account<'info, MarketCalendar>>,

    #[account(
        mut,
        seeds = [
            SERIES_SEED,
            series.underlying_mint.as_ref(),
            &series.expiry_ts.to_le_bytes(),
            &series.strike0.to_le_bytes(),
            &[series.kind as u8],
        ],
        bump = series.bump,
    )]
    pub series: Box<Account<'info, OptionSeries>>,

    #[account(address = series.underlying_mint @ DeliverableError::MintMismatch)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        address = series.option_mint @ DeliverableError::MintMismatch,
    )]
    pub option_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        address = series.collateral_vault @ DeliverableError::MintMismatch,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = writer_underlying.mint == series.underlying_mint @ DeliverableError::MintMismatch,
        constraint = writer_underlying.owner == writer.key() @ DeliverableError::NotPositionOwner,
    )]
    pub writer_underlying: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = writer_option.mint == series.option_mint @ DeliverableError::MintMismatch,
        constraint = writer_option.owner == writer.key() @ DeliverableError::NotPositionOwner,
    )]
    pub writer_option: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        seeds = [WRITER_SEED, series.key().as_ref(), writer.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == writer.key() @ DeliverableError::NotPositionOwner,
        constraint = position.series == series.key() @ DeliverableError::SecurityMismatch,
    )]
    pub position: Box<Account<'info, WriterPosition>>,

    /// CHECK: decoded by `oracle::observe` against the registered source.
    pub primary_oracle: UncheckedAccount<'info>,
    /// CHECK: as above.
    pub secondary_oracle: UncheckedAccount<'info>,

    pub underlying_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct OpenPosition<'info> {
    #[account(mut)]
    pub writer: Signer<'info>,
    pub series: Box<Account<'info, OptionSeries>>,
    #[account(
        init,
        payer = writer,
        space = 8 + WriterPosition::INIT_SPACE,
        seeds = [WRITER_SEED, series.key().as_ref(), writer.key().as_ref()],
        bump,
    )]
    pub position: Box<Account<'info, WriterPosition>>,
    pub system_program: Program<'info, System>,
}

/// Open an empty position, once per writer per series.
///
/// Separate from `write` rather than folded into it as an `init_if_needed`: a
/// constraint that sometimes initialises is the constraint people get wrong,
/// and the cost of being explicit is one instruction the SDK bundles into the
/// same transaction as the first write.
pub fn open_position(ctx: Context<OpenPosition>) -> Result<()> {
    let position = &mut ctx.accounts.position;
    position.owner = ctx.accounts.writer.key();
    position.series = ctx.accounts.series.key();
    position.contracts = 0;
    position.raw_collateral = 0;
    position.premium_claimed = 0;
    position.settled = false;
    position.bump = ctx.bumps.position;
    Ok(())
}

/// Writing is a state-changing action against the security, so it takes the
/// same gate settlement does. A venue that will not settle at Friday's close on
/// a Sunday but will happily let you write a new contract at that price has
/// only moved the problem.
pub fn write<'info>(ctx: Context<'info, Write<'info>>, contracts: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(contracts > 0, DeliverableError::ZeroAmount);

    assert_security_actionable(
        &ctx.accounts.security,
        &ctx.accounts.calendar,
        &ctx.accounts.underlying_mint,
        &ctx.accounts.primary_oracle.to_account_info(),
        &ctx.accounts.secondary_oracle.to_account_info(),
        now,
    )?;

    require!(
        ctx.accounts.series.phase(&ctx.accounts.calendar, now) == SeriesPhase::Active,
        DeliverableError::WrongSeriesState
    );
    let written = ctx
        .accounts
        .series
        .contracts_written
        .checked_add(contracts)
        .ok_or(DeliverableError::MathOverflow)?;
    require!(
        written <= MAX_CONTRACTS_PER_SERIES,
        DeliverableError::MathOverflow
    );

    let raw = ctx.accounts.series.delivery_raw(contracts)?;

    transfer_checked_forwarding(
        &ctx.accounts.underlying_token_program.to_account_info(),
        ctx.accounts.writer_underlying.to_account_info(),
        ctx.accounts.underlying_mint.to_account_info(),
        ctx.accounts.collateral_vault.to_account_info(),
        ctx.accounts.writer.to_account_info(),
        ctx.remaining_accounts,
        raw,
        ctx.accounts.underlying_mint.decimals,
        &[],
    )?;

    let series_key = ctx.accounts.series.key();
    let signer = SeriesSigner::new(&ctx.accounts.series);
    let seeds = signer.seeds();
    mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.underlying_token_program.key(),
            MintTo {
                mint: ctx.accounts.option_mint.to_account_info(),
                to: ctx.accounts.writer_option.to_account_info(),
                authority: ctx.accounts.series.to_account_info(),
            },
            &[&seeds],
        ),
        contracts,
    )?;

    let series = &mut ctx.accounts.series;
    series.contracts_written = written;

    let position = &mut ctx.accounts.position;
    position.contracts = position
        .contracts
        .checked_add(contracts)
        .ok_or(DeliverableError::MathOverflow)?;
    position.raw_collateral = position
        .raw_collateral
        .checked_add(raw)
        .ok_or(DeliverableError::MathOverflow)?;

    emit!(ContractsWritten {
        series: series_key,
        writer: position.owner,
        contracts,
        raw_collateral: raw,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimPremium<'info> {
    pub writer: Signer<'info>,
    #[account(
        mut,
        seeds = [
            SERIES_SEED,
            series.underlying_mint.as_ref(),
            &series.expiry_ts.to_le_bytes(),
            &series.strike0.to_le_bytes(),
            &[series.kind as u8],
        ],
        bump = series.bump,
    )]
    pub series: Box<Account<'info, OptionSeries>>,
    #[account(
        mut,
        seeds = [WRITER_SEED, series.key().as_ref(), writer.key().as_ref()],
        bump = position.bump,
        constraint = position.owner == writer.key() @ DeliverableError::NotPositionOwner,
    )]
    pub position: Box<Account<'info, WriterPosition>>,
    #[account(address = series.underlying_mint @ DeliverableError::MintMismatch)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        seeds = [PREMIUM_SEED, series.key().as_ref()],
        bump,
        address = series.premium_vault @ DeliverableError::MintMismatch,
    )]
    pub premium_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = writer_underlying.mint == series.underlying_mint @ DeliverableError::MintMismatch,
        constraint = writer_underlying.owner == writer.key() @ DeliverableError::NotPositionOwner,
    )]
    pub writer_underlying: Box<InterfaceAccount<'info, TokenAccount>>,
    pub underlying_token_program: Interface<'info, TokenInterface>,
}

/// Premium is denominated in the underlying share, so a covered call written
/// here accumulates the share itself.
///
/// There is no `deposit_premium`: the vault's own balance is the total, plus
/// what has already been paid out. Premium can therefore arrive as a plain
/// transfer — which is what a Meteora fee claim on a stock-quoted pool is — and
/// the writer's entitlement re-derives from the balance rather than from a
/// number somebody had to remember to write down.
pub fn claim_premium<'info>(
    ctx: Context<'info, ClaimPremium<'info>>,
) -> Result<()> {
    let series = &ctx.accounts.series;
    require!(
        series.contracts_written > 0,
        DeliverableError::NothingToSettle
    );

    let pool = (ctx.accounts.premium_vault.amount as u128)
        .checked_add(series.premium_claimed_total as u128)
        .ok_or(DeliverableError::MathOverflow)?;
    let entitled = mul_div_floor(
        pool,
        ctx.accounts.position.contracts as u128,
        series.contracts_written as u128,
    )?;
    let entitled = u64::try_from(entitled).map_err(|_| DeliverableError::MathOverflow)?;
    let payout = entitled.saturating_sub(ctx.accounts.position.premium_claimed);
    require!(payout > 0, DeliverableError::PremiumAlreadyClaimed);

    let signer = SeriesSigner::new(series);
    let seeds = signer.seeds();
    transfer_checked_forwarding(
        &ctx.accounts.underlying_token_program.to_account_info(),
        ctx.accounts.premium_vault.to_account_info(),
        ctx.accounts.underlying_mint.to_account_info(),
        ctx.accounts.writer_underlying.to_account_info(),
        ctx.accounts.series.to_account_info(),
        ctx.remaining_accounts,
        payout,
        ctx.accounts.underlying_mint.decimals,
        &[&seeds],
    )?;

    let series_key = ctx.accounts.series.key();
    let writer = ctx.accounts.writer.key();
    ctx.accounts.series.premium_claimed_total = ctx
        .accounts
        .series
        .premium_claimed_total
        .checked_add(payout)
        .ok_or(DeliverableError::MathOverflow)?;
    ctx.accounts.position.premium_claimed = ctx
        .accounts
        .position
        .premium_claimed
        .checked_add(payout)
        .ok_or(DeliverableError::MathOverflow)?;

    emit!(PremiumClaimed {
        series: series_key,
        writer,
        amount: payout,
    });
    Ok(())
}
