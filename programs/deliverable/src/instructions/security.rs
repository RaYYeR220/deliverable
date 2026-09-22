//! `register_security`, `sync_security`, `attest_halt`, `probe_security`.
//!
//! `sync_security` is the only instruction whose entire job is to write down
//! what other accounts already say. It is not load-bearing for settlement — the
//! gate re-reads the mint and the oracle itself — but it is what makes the rail
//! readable by a program that does not want to decode a Token-2022 TLV or a
//! 28kB Scope account, which was the point of publishing a rail at all.

use anchor_lang::prelude::*;
use anchor_spl::token_interface::Mint;

use crate::calendar::{resolve_session, Session};
use crate::constants::{CALENDAR_SEED, REGISTRY_SEED, SECURITY_SEED};
use crate::error::{DeliverableError, RefusalCode};
use crate::gate::{check_actionable, emit_refusal, GateInputs, HaltState};
use crate::mint_guards::read_mint_guards;
use crate::oracle::{observe, Observation, OracleBinding};
use crate::scaled_ui::read_multiplier;
use crate::state::{
    HaltAttested, MarketCalendar, Registry, SecurityRegistered, SecurityState, SecuritySynced,
};

#[derive(Accounts)]
pub struct RegisterSecurity<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        has_one = authority @ DeliverableError::NotAuthority,
    )]
    pub registry: Account<'info, Registry>,
    /// The security *is* its mint. One security per mint, forever.
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        seeds = [CALENDAR_SEED, &calendar.id.to_le_bytes()],
        bump = calendar.bump,
    )]
    pub calendar: Box<Account<'info, MarketCalendar>>,
    #[account(
        init,
        payer = authority,
        space = 8 + SecurityState::INIT_SPACE,
        seeds = [SECURITY_SEED, underlying_mint.key().as_ref()],
        bump,
    )]
    pub security: Box<Account<'info, SecurityState>>,
    pub system_program: Program<'info, System>,
}

pub fn register_security(
    ctx: Context<RegisterSecurity>,
    symbol: [u8; 12],
    sources: OracleBinding,
    max_price_age: u32,
    max_conf_bps: u32,
    max_divergence_bps: u32,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mint = &ctx.accounts.underlying_mint;

    // We only cover securities whose corporate actions are expressible. A mint
    // without ScaledUiAmount has no way to tell us a split happened, and a
    // contract on it would silently become a contract on something else.
    let multiplier = read_multiplier(mint, now)?;
    let guards = read_mint_guards(mint)?;

    require!(max_price_age > 0, DeliverableError::ZeroAmount);
    require!(max_divergence_bps > 0, DeliverableError::ZeroAmount);

    let security = &mut ctx.accounts.security;
    security.underlying_mint = mint.key();
    security.symbol = symbol;
    security.calendar_id = ctx.accounts.calendar.id;
    security.decimals = mint.decimals;
    security.bump = ctx.bumps.security;
    security.sources = sources;
    security.observed_multiplier = multiplier.effective;
    security.pending_multiplier = multiplier.pending.map(|(m, _)| m).unwrap_or(0);
    security.pending_effective_ts = multiplier.pending.map(|(_, ts)| ts).unwrap_or(0);
    security.multiplier_epoch = 1;
    security.mint_paused = guards.paused;
    security.transfer_hook = guards.transfer_hook;
    security.primary = Observation {
        price: 0,
        conf: 0,
        expo: 0,
        publish_ts: 0,
    };
    security.secondary = None;
    security.synced_ts = 0;
    security.halt = HaltState::default();
    security.max_price_age = max_price_age;
    security.max_conf_bps = max_conf_bps;
    security.max_divergence_bps = max_divergence_bps;
    security.refusals = 0;
    security.last_refusal_code = 0;
    security.last_refusal_ts = 0;

    emit!(SecurityRegistered {
        security: security.key(),
        underlying_mint: security.underlying_mint,
        symbol,
        calendar_id: security.calendar_id,
        multiplier: multiplier.effective,
    });
    Ok(())
}

/// The accounts every read of a security needs: the mint it is, and the one or
/// two oracle accounts it is priced from.
#[derive(Accounts)]
pub struct ReadSecurity<'info> {
    #[account(
        mut,
        seeds = [SECURITY_SEED, underlying_mint.key().as_ref()],
        bump = security.bump,
    )]
    pub security: Box<Account<'info, SecurityState>>,
    #[account(address = security.underlying_mint @ DeliverableError::MintMismatch)]
    pub underlying_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: identified and decoded by `oracle::observe` against the source
    /// this security was registered with; an account from the wrong program is
    /// rejected there.
    pub primary_oracle: UncheckedAccount<'info>,
    /// CHECK: as above. Pass `primary_oracle` again for a security registered
    /// with a single declared source — it is never read in that case, and the
    /// gate refuses regardless.
    pub secondary_oracle: UncheckedAccount<'info>,
}

pub fn sync_security(ctx: Context<ReadSecurity>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mint = &ctx.accounts.underlying_mint;

    let multiplier = read_multiplier(mint, now)?;
    let guards = read_mint_guards(mint)?;

    let security = &mut ctx.accounts.security;
    let primary = observe(
        &security.sources.primary(),
        &ctx.accounts.primary_oracle.to_account_info(),
        now,
    )?;
    let secondary = match security.sources.secondary() {
        Some(source) => Some(observe(
            &source,
            &ctx.accounts.secondary_oracle.to_account_info(),
            now,
        )?),
        None => None,
    };

    if security.observed_multiplier != multiplier.effective {
        security.multiplier_epoch = security.multiplier_epoch.saturating_add(1);
    }
    security.observed_multiplier = multiplier.effective;
    security.pending_multiplier = multiplier.pending.map(|(m, _)| m).unwrap_or(0);
    security.pending_effective_ts = multiplier.pending.map(|(_, ts)| ts).unwrap_or(0);
    security.mint_paused = guards.paused;
    security.transfer_hook = guards.transfer_hook;
    security.primary = primary;
    security.secondary = secondary;
    security.synced_ts = now;
    security.decimals = mint.decimals;

    emit!(SecuritySynced {
        security: security.key(),
        multiplier: multiplier.effective,
        multiplier_epoch: security.multiplier_epoch,
        price: primary.price,
        expo: primary.expo,
        publish_ts: primary.publish_ts,
        at: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AttestHalt<'info> {
    pub attestor: Signer<'info>,
    #[account(
        seeds = [REGISTRY_SEED],
        bump = registry.bump,
        constraint = registry.attestor == attestor.key() @ DeliverableError::NotAttestor,
    )]
    pub registry: Account<'info, Registry>,
    #[account(
        mut,
        seeds = [SECURITY_SEED, security.underlying_mint.as_ref()],
        bump = security.bump,
    )]
    pub security: Box<Account<'info, SecurityState>>,
}

/// A halt is the one state no on-chain source can report: `PriceUpdateV2`
/// dropped the legacy `PriceStatus` enum, so halted, closed, outage and early
/// close are indistinguishable from staleness. It therefore arrives signed and
/// is stored rather than inferred — and the signer is fixed in the registry, so
/// the trust assumption is named rather than hidden.
pub fn attest_halt(
    ctx: Context<AttestHalt>,
    halted: bool,
    since_ts: i64,
    source: u8,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let security = &mut ctx.accounts.security;
    security.halt = HaltState {
        halted,
        since_ts,
        attested_ts: now,
        source,
    };
    emit!(HaltAttested {
        security: security.key(),
        halted,
        since_ts,
        at: now,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct ProbeSecurity<'info> {
    #[account(
        mut,
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
    /// CHECK: see `ReadSecurity`.
    pub primary_oracle: UncheckedAccount<'info>,
    /// CHECK: see `ReadSecurity`.
    pub secondary_oracle: UncheckedAccount<'info>,
}

/// Ask the gate whether the security is actionable, and record the answer.
///
/// Every other caller of the gate reverts when it refuses, which takes the
/// refusal counter with it — a refused transaction cannot write down that it
/// refused. This one succeeds either way, so the count and the last code live
/// on the account and the UI can show "refused 41 times today, code 1" without
/// an indexer. The `Refused` event goes out identically in both paths.
pub fn probe_security(ctx: Context<ProbeSecurity>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // A closed market is decided before any oracle is read, for the reason
    // given on `gate::refuse_if_closed`. This path records rather than reverts,
    // so it cannot reuse that helper directly.
    if resolve_session(&ctx.accounts.calendar, now) == Session::Closed {
        return record_refusal(&mut ctx.accounts.security, RefusalCode::MarketClosed, now);
    }

    let mint = &ctx.accounts.underlying_mint;
    let security = &ctx.accounts.security;

    let multiplier = read_multiplier(mint, now)?;
    let guards = read_mint_guards(mint)?;
    let primary_source = security.sources.primary();
    let primary = observe(
        &primary_source,
        &ctx.accounts.primary_oracle.to_account_info(),
        now,
    )?;
    let secondary = match security.sources.secondary() {
        Some(source) => Some((
            source,
            observe(
                &source,
                &ctx.accounts.secondary_oracle.to_account_info(),
                now,
            )?,
        )),
        None => None,
    };

    let inputs = GateInputs {
        security: security.key(),
        now,
        calendar: &ctx.accounts.calendar,
        halt: security.halt,
        mint_paused: guards.paused,
        transfer_hook: guards.transfer_hook,
        multiplier,
        primary_source,
        primary,
        secondary,
        max_age: security.max_price_age,
        max_conf_bps: security.max_conf_bps,
        max_divergence_bps: security.max_divergence_bps,
    };

    match check_actionable(&inputs)? {
        None => {
            msg!("actionable at {}", now);
            Ok(())
        }
        Some(code) => record_refusal(&mut ctx.accounts.security, code, now),
    }
}

fn record_refusal(
    security: &mut Account<SecurityState>,
    code: RefusalCode,
    now: i64,
) -> Result<()> {
    emit_refusal(security.key(), code, now);
    security.refusals = security.refusals.saturating_add(1);
    security.last_refusal_code = code as u8;
    security.last_refusal_ts = now;
    msg!("refused code={} at={}", code as u8, now);
    Ok(())
}
