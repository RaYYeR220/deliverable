//! Instruction handlers, and the two pieces of plumbing they all share:
//! gathering the gate's inputs from live accounts, and moving tokens in a way
//! that stays correct if a transfer hook is ever attached.

pub mod admin;
pub mod security;
pub mod series;
pub mod settle;
pub mod write;

pub use admin::*;
pub use security::*;
pub use series::*;
pub use settle::*;
pub use write::*;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token_2022::spl_token_2022;
use anchor_spl::token_interface::Mint;

use crate::constants::SERIES_SEED;
use crate::error::DeliverableError;
use crate::gate::{assert_actionable, GateInputs};
use crate::mint_guards::read_mint_guards;
use crate::oracle::observe;
use crate::scaled_ui::{read_multiplier, MintMultiplier};
use crate::state::{MarketCalendar, OptionSeries, SecurityState};

/// The series PDA's own seeds, materialised into owned bytes.
///
/// Signing a CPI needs `&[&[&[u8]]]`, and the little-endian encodings of the
/// expiry and the strike are temporaries: built inline they are dropped before
/// the CPI that borrows them. Holding them in a value is the difference between
/// compiling and not.
pub struct SeriesSigner {
    underlying_mint: Pubkey,
    quote_mint: Pubkey,
    expiry: [u8; 8],
    strike: [u8; 8],
    raw_size: [u8; 8],
    window: [u8; 2],
    kind: [u8; 1],
    adjust: [u8; 1],
    bump: [u8; 1],
}

impl SeriesSigner {
    pub fn new(series: &OptionSeries) -> Self {
        Self {
            underlying_mint: series.underlying_mint,
            quote_mint: series.quote_mint,
            expiry: series.expiry_ts.to_le_bytes(),
            strike: series.strike0.to_le_bytes(),
            raw_size: series.contract_raw_size.to_le_bytes(),
            window: series.settlement_window_minutes.to_le_bytes(),
            kind: [series.kind as u8],
            adjust: [series.adjust_on_corporate_action as u8],
            bump: [series.bump],
        }
    }

    pub fn seeds(&self) -> [&[u8]; 10] {
        [
            SERIES_SEED,
            self.underlying_mint.as_ref(),
            self.quote_mint.as_ref(),
            &self.expiry,
            &self.strike,
            &self.raw_size,
            &self.window,
            &self.kind,
            &self.adjust,
            &self.bump,
        ]
    }
}

/// Everything the gate concluded, handed back so the caller does not re-read
/// the mint it just proved was readable.
pub struct Actionable {
    pub multiplier: MintMultiplier,
    pub price: crate::oracle::Observation,
}

/// Build the gate's inputs from live accounts and run it.
///
/// Every input is read here, in this transaction: the multiplier and both
/// issuer levers come off the mint, the prices come off the oracle accounts.
/// Nothing is taken from `SecurityState`, which holds only the last sync and
/// exists so a reader can see the rail without reconstructing it.
pub fn assert_security_actionable<'info>(
    security: &Account<'info, SecurityState>,
    calendar: &Account<'info, MarketCalendar>,
    mint: &InterfaceAccount<'info, Mint>,
    primary_oracle: &AccountInfo<'info>,
    secondary_oracle: &AccountInfo<'info>,
    now: i64,
) -> Result<Actionable> {
    require_keys_eq!(
        mint.key(),
        security.underlying_mint,
        DeliverableError::MintMismatch
    );
    require_eq!(
        calendar.id,
        security.calendar_id,
        DeliverableError::CalendarMismatch
    );

    // Before any oracle is read: see `gate::refuse_if_closed`.
    crate::gate::refuse_if_closed(security.key(), calendar, now)?;

    let multiplier = read_multiplier(mint, now)?;
    let guards = read_mint_guards(mint)?;

    let primary_source = security.sources.primary();
    let primary = observe(&primary_source, primary_oracle, now)?;
    let secondary = match security.sources.secondary() {
        Some(source) => Some((source, observe(&source, secondary_oracle, now)?)),
        None => None,
    };

    let inputs = GateInputs {
        security: security.key(),
        now,
        calendar,
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
    assert_actionable(&inputs)?;

    Ok(Actionable {
        multiplier,
        price: primary,
    })
}

/// `TransferChecked`, with any accounts the caller passed through forwarded to
/// the token program.
///
/// `anchor_spl`'s helper invokes with exactly four accounts, which is correct
/// today and wrong the moment `transferHook.programId` stops being null on an
/// xStock — and Backed holds a live authority over that field on all of them.
/// Forwarding `remaining_accounts` costs nothing while the hook is empty and is
/// the difference between working and not working if it is ever filled.
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked_forwarding<'info>(
    token_program: &AccountInfo<'info>,
    from: AccountInfo<'info>,
    mint: AccountInfo<'info>,
    to: AccountInfo<'info>,
    authority: AccountInfo<'info>,
    extra_accounts: &[AccountInfo<'info>],
    amount: u64,
    decimals: u8,
    signer_seeds: &[&[&[u8]]],
) -> Result<()> {
    let extra_metas: Vec<AccountMeta> = extra_accounts
        .iter()
        .map(|extra| AccountMeta {
            pubkey: *extra.key,
            is_signer: extra.is_signer,
            is_writable: extra.is_writable,
        })
        .collect();
    let ix = transfer_checked_instruction(
        token_program.key,
        from.key,
        mint.key,
        to.key,
        authority.key,
        &extra_metas,
        amount,
        decimals,
    )?;

    let mut infos = Vec::with_capacity(5 + extra_accounts.len());
    infos.push(from);
    infos.push(mint);
    infos.push(to);
    infos.push(authority);
    infos.extend(extra_accounts.iter().cloned());
    infos.push(token_program.clone());

    invoke_signed(&ix, &infos, signer_seeds).map_err(Into::into)
}

/// The instruction `transfer_checked_forwarding` sends, built but not invoked.
///
/// Separate so the forwarding itself is assertable: whether the extra accounts
/// reach the token program is a property of this instruction's account list,
/// and a test that only watched a transfer succeed would not notice them being
/// dropped, because SPL Token ignores accounts it was not expecting.
#[allow(clippy::too_many_arguments)]
pub fn transfer_checked_instruction(
    token_program: &Pubkey,
    from: &Pubkey,
    mint: &Pubkey,
    to: &Pubkey,
    authority: &Pubkey,
    extra_accounts: &[AccountMeta],
    amount: u64,
    decimals: u8,
) -> Result<anchor_lang::solana_program::instruction::Instruction> {
    let mut ix = spl_token_2022::instruction::transfer_checked(
        token_program,
        from,
        mint,
        to,
        authority,
        &[],
        amount,
        decimals,
    )?;
    ix.accounts.extend_from_slice(extra_accounts);
    Ok(ix)
}
