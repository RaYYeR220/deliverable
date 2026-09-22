//! Registry and calendar administration.
//!
//! The calendar is data, not code: a new year's holidays are appended by the
//! authority rather than shipped in a program upgrade, because the schedule
//! moves every year and an options venue that needs a redeploy each December is
//! an options venue that will one day settle on Christmas Eve.

use anchor_lang::prelude::*;

use crate::constants::{CALENDAR_SEED, REGISTRY_SEED};
use crate::error::DeliverableError;
use crate::state::{CalendarEntry, MarketCalendar, Registry, MAX_CALENDAR_ENTRIES};

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Registry::INIT_SPACE,
        seeds = [REGISTRY_SEED],
        bump,
    )]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}

pub fn init_registry(ctx: Context<InitRegistry>, attestor: Pubkey) -> Result<()> {
    let registry = &mut ctx.accounts.registry;
    registry.authority = ctx.accounts.authority.key();
    registry.attestor = attestor;
    registry.paused = false;
    registry.bump = ctx.bumps.registry;
    Ok(())
}

#[derive(Accounts)]
pub struct SetRegistryPaused<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ DeliverableError::NotAuthority,
    )]
    pub registry: Account<'info, Registry>,
}

pub fn set_registry_paused(ctx: Context<SetRegistryPaused>, paused: bool) -> Result<()> {
    ctx.accounts.registry.paused = paused;
    Ok(())
}

#[derive(Accounts)]
#[instruction(id: u16)]
pub struct InitCalendar<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ DeliverableError::NotAuthority,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        init,
        payer = authority,
        space = 8 + MarketCalendar::INIT_SPACE,
        seeds = [CALENDAR_SEED, &id.to_le_bytes()],
        bump,
    )]
    pub calendar: Box<Account<'info, MarketCalendar>>,
    pub system_program: Program<'info, System>,
}

pub fn init_calendar(
    ctx: Context<InitCalendar>,
    id: u16,
    regular_open_minute: u16,
    regular_close_minute: u16,
) -> Result<()> {
    require!(
        regular_open_minute < regular_close_minute && regular_close_minute <= 24 * 60,
        DeliverableError::ZeroAmount
    );
    let calendar = &mut ctx.accounts.calendar;
    calendar.authority = ctx.accounts.authority.key();
    calendar.id = id;
    calendar.version = 1;
    calendar.regular_open_minute = regular_open_minute;
    calendar.regular_close_minute = regular_close_minute;
    calendar.bump = ctx.bumps.calendar;
    calendar.entries = Vec::new();
    Ok(())
}

#[derive(Accounts)]
pub struct AppendCalendarEntries<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [CALENDAR_SEED, &calendar.id.to_le_bytes()],
        bump = calendar.bump,
        has_one = authority @ DeliverableError::NotAuthority,
    )]
    pub calendar: Box<Account<'info, MarketCalendar>>,
}

pub fn append_calendar_entries(
    ctx: Context<AppendCalendarEntries>,
    entries: Vec<CalendarEntry>,
) -> Result<()> {
    let calendar = &mut ctx.accounts.calendar;
    require!(
        calendar.entries.len() + entries.len() <= MAX_CALENDAR_ENTRIES,
        DeliverableError::CalendarFull
    );
    for entry in entries {
        // Replacing rather than appending a duplicate keeps `exception`'s
        // linear scan unambiguous when a half-day is later corrected.
        match calendar
            .entries
            .iter_mut()
            .find(|e| e.date_key == entry.date_key)
        {
            Some(existing) => *existing = entry,
            None => calendar.entries.push(entry),
        }
    }
    // Bumped so an indexer can tell which schedule a past refusal was decided
    // under; the entries themselves carry no history.
    calendar.version = calendar.version.saturating_add(1);
    Ok(())
}
