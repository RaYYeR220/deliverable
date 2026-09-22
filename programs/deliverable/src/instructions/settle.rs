//! `exercise` and `settle_expired` — the two ends of physical delivery.
//!
//! Exercise is where the whole argument gets tested: the holder pays the strike
//! the *mint* implies right now, and receives the real tokenized share out of a
//! vault. Every number in that sentence is re-derived in the transaction that
//! uses it, and the gate is consulted before any of it happens.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn, Burn, Mint, TokenAccount, TokenInterface};

use crate::constants::{
    CALENDAR_SEED, QUOTE_SEED, REGISTRY_SEED, SECURITY_SEED, SERIES_SEED, VAULT_SEED, WRITER_SEED,
};
use crate::error::DeliverableError;
use crate::fixed::mul_div_floor;
use crate::instructions::{
    assert_security_actionable, transfer_checked_forwarding, SeriesSigner,
};
use crate::mint_guards::read_mint_guards;
use crate::scaled_ui::read_multiplier;
use crate::state::{
    Exercised, MarketCalendar, OptionSeries, PositionSettled, Registry, SecurityState,
    SeriesPhase, WriterPosition,
};

#[derive(Accounts)]
pub struct Exercise<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
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
            series.quote_mint.as_ref(),
            &series.expiry_ts.to_le_bytes(),
            &series.strike0.to_le_bytes(),
            &series.contract_raw_size.to_le_bytes(),
            &series.settlement_window_minutes.to_le_bytes(),
            &[series.kind as u8],
            &[series.adjust_on_corporate_action as u8],
        ],
        bump = series.bump,
    )]
    pub series: Box<Account<'info, OptionSeries>>,

    #[account(address = series.underlying_mint @ DeliverableError::MintMismatch)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(address = series.quote_mint @ DeliverableError::MintMismatch)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = series.option_mint @ DeliverableError::MintMismatch)]
    pub option_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, series.key().as_ref()],
        bump,
        address = series.collateral_vault @ DeliverableError::MintMismatch,
    )]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        seeds = [QUOTE_SEED, series.key().as_ref()],
        bump,
        address = series.quote_vault @ DeliverableError::MintMismatch,
    )]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,

    #[account(
        mut,
        constraint = holder_option.mint == series.option_mint @ DeliverableError::MintMismatch,
        constraint = holder_option.owner == holder.key() @ DeliverableError::NotPositionOwner,
    )]
    pub holder_option: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = holder_quote.mint == series.quote_mint @ DeliverableError::MintMismatch,
        constraint = holder_quote.owner == holder.key() @ DeliverableError::NotPositionOwner,
    )]
    pub holder_quote: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = holder_underlying.mint == series.underlying_mint @ DeliverableError::MintMismatch,
        constraint = holder_underlying.owner == holder.key() @ DeliverableError::NotPositionOwner,
    )]
    pub holder_underlying: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: decoded by `oracle::observe` against the registered source.
    pub primary_oracle: UncheckedAccount<'info>,
    /// CHECK: as above.
    pub secondary_oracle: UncheckedAccount<'info>,

    pub underlying_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

/// European exercise, physically settled.
///
/// The order is deliberate: the gate first, so a refusal costs the holder a
/// failed transaction rather than a bad fill; then the window; then the price.
/// The strike charged is `strike0 * m0 / m1` read off the mint in this
/// transaction — after a ten-for-one split the holder pays a tenth per share
/// and takes delivery of ten times as many, and the writer's dollars are
/// untouched.
pub fn exercise<'info>(
    ctx: Context<'info, Exercise<'info>>,
    contracts: u64,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(contracts > 0, DeliverableError::ZeroAmount);

    let actionable = assert_security_actionable(
        &ctx.accounts.security,
        &ctx.accounts.calendar,
        &ctx.accounts.underlying_mint,
        &ctx.accounts.primary_oracle.to_account_info(),
        &ctx.accounts.secondary_oracle.to_account_info(),
        now,
    )?;

    // The window is measured in minutes the venue was actually able to act in.
    // Everything the gate just proved is now behind us, so a refusal that ran
    // through part of the window gives that part of the window back instead of
    // expiring the holder's option against a market they were refused entry to.
    let refused = ctx.accounts.series.refused_window_minutes(
        &ctx.accounts.calendar,
        &ctx.accounts.security.halt,
        &actionable.multiplier,
        now,
    );
    let phase = ctx
        .accounts
        .series
        .phase_with_refusals(&ctx.accounts.calendar, now, refused);
    require!(
        phase != SeriesPhase::Active,
        DeliverableError::SettlementWindowNotOpen
    );
    require!(
        phase == SeriesPhase::Settling,
        DeliverableError::SettlementWindowClosed
    );

    let multiplier = actionable.multiplier.effective;
    // The mint's multiplier is the issuer's to set and ours to price against.
    // Past the band it is not a corporate action any more, and a re-cut strike
    // derived from it is not a price — refusing is the only honest answer.
    ctx.accounts.series.require_multiplier_in_band(multiplier)?;
    let strike = ctx.accounts.series.current_strike(multiplier)?;
    let cost = ctx.accounts.series.exercise_cost(multiplier, contracts)?;
    let raw = ctx.accounts.series.delivery_raw(contracts)?;
    require!(
        ctx.accounts.collateral_vault.amount >= raw,
        DeliverableError::InsufficientCollateral
    );

    // Burn first. An option token that has been spent must not survive a
    // failure later in the instruction, and a revert takes the burn with it.
    burn(
        CpiContext::new(
            ctx.accounts.underlying_token_program.key(),
            Burn {
                mint: ctx.accounts.option_mint.to_account_info(),
                from: ctx.accounts.holder_option.to_account_info(),
                authority: ctx.accounts.holder.to_account_info(),
            },
        ),
        contracts,
    )?;

    transfer_checked_forwarding(
        &ctx.accounts.quote_token_program.to_account_info(),
        ctx.accounts.holder_quote.to_account_info(),
        ctx.accounts.quote_mint.to_account_info(),
        ctx.accounts.quote_vault.to_account_info(),
        ctx.accounts.holder.to_account_info(),
        &[],
        cost,
        ctx.accounts.quote_mint.decimals,
        &[],
    )?;

    let signer = SeriesSigner::new(&ctx.accounts.series);
    let seeds = signer.seeds();
    transfer_checked_forwarding(
        &ctx.accounts.underlying_token_program.to_account_info(),
        ctx.accounts.collateral_vault.to_account_info(),
        ctx.accounts.underlying_mint.to_account_info(),
        ctx.accounts.holder_underlying.to_account_info(),
        ctx.accounts.series.to_account_info(),
        ctx.remaining_accounts,
        raw,
        ctx.accounts.underlying_mint.decimals,
        &[&seeds],
    )?;

    let series_key = ctx.accounts.series.key();
    let holder = ctx.accounts.holder.key();
    let series = &mut ctx.accounts.series;
    series.contracts_exercised = series
        .contracts_exercised
        .checked_add(contracts)
        .ok_or(DeliverableError::MathOverflow)?;
    require!(
        series.contracts_exercised <= series.contracts_written,
        DeliverableError::InsufficientCollateral
    );
    series.quote_collected = series
        .quote_collected
        .checked_add(cost)
        .ok_or(DeliverableError::MathOverflow)?;
    if series.window_opened_ts == 0 {
        series.window_opened_ts = now;
    }

    emit!(Exercised {
        series: series_key,
        holder,
        contracts,
        strike,
        quote_paid: cost,
        raw_delivered: raw,
        at: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleExpired<'info> {
    pub writer: Signer<'info>,
    /// Carried for one reason: without it there is nothing to bind the calendar
    /// to. `OptionSeries` does not store a calendar id, so the only check on
    /// the account that decides whether the exercise window has run out was
    /// that it is *a* calendar — and a writer who hands in one that says the
    /// window is over takes the collateral back before any holder can exercise.
    #[account(
        seeds = [SECURITY_SEED, series.underlying_mint.as_ref()],
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
            series.quote_mint.as_ref(),
            &series.expiry_ts.to_le_bytes(),
            &series.strike0.to_le_bytes(),
            &series.contract_raw_size.to_le_bytes(),
            &series.settlement_window_minutes.to_le_bytes(),
            &[series.kind as u8],
            &[series.adjust_on_corporate_action as u8],
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
    #[account(address = series.quote_mint @ DeliverableError::MintMismatch)]
    pub quote_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = series.collateral_vault @ DeliverableError::MintMismatch)]
    pub collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, address = series.quote_vault @ DeliverableError::MintMismatch)]
    pub quote_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = writer_underlying.mint == series.underlying_mint @ DeliverableError::MintMismatch,
        constraint = writer_underlying.owner == writer.key() @ DeliverableError::NotPositionOwner,
    )]
    pub writer_underlying: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = writer_quote.mint == series.quote_mint @ DeliverableError::MintMismatch,
        constraint = writer_quote.owner == writer.key() @ DeliverableError::NotPositionOwner,
    )]
    pub writer_quote: Box<InterfaceAccount<'info, TokenAccount>>,

    pub underlying_token_program: Interface<'info, TokenInterface>,
    pub quote_token_program: Interface<'info, TokenInterface>,
}

/// Close out one writer once the exercise window has run its course.
///
/// Assigned contracts are paid in the quote asset the holders handed over;
/// everything unassigned comes back as the raw share it went in as. Still no
/// *gate* here: by this point the security's state cannot change the outcome,
/// and a halt must not be able to strand a writer's collateral. What the halt
/// and the mint do decide is the **clock** — how much of the exercise window
/// the holders actually got — which is a different question from whether this
/// instruction may run, and answering it here is what stops a refusal spanning
/// the window from silently expiring every in-the-money option in it.
pub fn settle_expired<'info>(
    ctx: Context<'info, SettleExpired<'info>>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // The multiplier is read for the clock, not for a price: a change's
    // effective timestamp stays on the mint after it lands, so the minutes its
    // quiet period refused over are still subtractable at settlement.
    let multiplier = read_multiplier(&ctx.accounts.underlying_mint, now)?;
    let refused = ctx.accounts.series.refused_window_minutes(
        &ctx.accounts.calendar,
        &ctx.accounts.security.halt,
        &multiplier,
        now,
    );
    require!(
        ctx.accounts
            .series
            .phase_with_refusals(&ctx.accounts.calendar, now, refused)
            == SeriesPhase::Settled,
        DeliverableError::SettlementWindowPostponed
    );

    // Not the gate, and deliberately only this one condition of it: forwarding
    // caller-chosen accounts into an attached hook program is a different risk
    // from acting on a stale price, and it is the one risk that does not go
    // away by virtue of the outcome already being fixed.
    let guards = read_mint_guards(&ctx.accounts.underlying_mint)?;
    require!(
        guards.transfer_hook.is_none(),
        DeliverableError::HookAttached
    );

    require!(
        !ctx.accounts.position.settled,
        DeliverableError::NothingToSettle
    );
    require!(
        ctx.accounts.position.contracts > 0,
        DeliverableError::NothingToSettle
    );

    // Assignment, conserving: the writers' assignments sum to exactly what was
    // exercised, so what they collectively reclaim is exactly what is in the
    // vault and settling first is worth nothing.
    let assigned = ctx
        .accounts
        .position
        .conserving_assignment(&ctx.accounts.series)?;
    let unassigned = ctx.accounts.position.contracts.saturating_sub(assigned);
    let raw_back = ctx.accounts.series.delivery_raw(unassigned)?;

    // Paid for what this writer actually delivered, not for what they wrote.
    // The two differ by the assignment remainder, and paying on the book while
    // assigning on the vault is what let one writer keep a share the next
    // writer had funded.
    let series = &ctx.accounts.series;
    let exercised = series.contracts_exercised as u128;
    let quote_due = if exercised == 0 {
        0u64
    } else {
        let before = mul_div_floor(
            series.quote_collected as u128,
            series.contracts_assigned_total as u128,
            exercised,
        )?;
        let after = mul_div_floor(
            series.quote_collected as u128,
            series
                .contracts_assigned_total
                .checked_add(assigned)
                .ok_or(DeliverableError::MathOverflow)? as u128,
            exercised,
        )?;
        u64::try_from(after.saturating_sub(before))
            .map_err(|_| DeliverableError::MathOverflow)?
    };

    // The clamp stays, but only as a last-resort guard against the underlying
    // leaving the vault by a route this program does not control — a
    // permanent-delegate seizure. Assignment conserves, so in every ordinary
    // settlement the shortfall is zero; when it is not, it goes on the wire.
    let raw_shortfall = raw_back.saturating_sub(ctx.accounts.collateral_vault.amount);
    let raw_back = raw_back.min(ctx.accounts.collateral_vault.amount);
    let quote_due = quote_due.min(ctx.accounts.quote_vault.amount);

    let signer = SeriesSigner::new(&ctx.accounts.series);
    let seeds = signer.seeds();

    if raw_back > 0 {
        transfer_checked_forwarding(
            &ctx.accounts.underlying_token_program.to_account_info(),
            ctx.accounts.collateral_vault.to_account_info(),
            ctx.accounts.underlying_mint.to_account_info(),
            ctx.accounts.writer_underlying.to_account_info(),
            ctx.accounts.series.to_account_info(),
            ctx.remaining_accounts,
            raw_back,
            ctx.accounts.underlying_mint.decimals,
            &[&seeds],
        )?;
    }
    if quote_due > 0 {
        transfer_checked_forwarding(
            &ctx.accounts.quote_token_program.to_account_info(),
            ctx.accounts.quote_vault.to_account_info(),
            ctx.accounts.quote_mint.to_account_info(),
            ctx.accounts.writer_quote.to_account_info(),
            ctx.accounts.series.to_account_info(),
            &[],
            quote_due,
            ctx.accounts.quote_mint.decimals,
            &[&seeds],
        )?;
    }

    let series_key = ctx.accounts.series.key();
    let writer = ctx.accounts.writer.key();
    let series = &mut ctx.accounts.series;
    series.contracts_assigned_total = series
        .contracts_assigned_total
        .checked_add(assigned)
        .ok_or(DeliverableError::MathOverflow)?;
    let position = &mut ctx.accounts.position;
    position.settled = true;
    position.raw_collateral = position.raw_collateral.saturating_sub(raw_back);

    emit!(PositionSettled {
        series: series_key,
        writer,
        contracts_assigned: assigned,
        raw_returned: raw_back,
        quote_paid: quote_due,
        raw_shortfall,
    });
    Ok(())
}
