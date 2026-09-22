//! `assert_actionable` — the refusal gate.
//!
//! One function, called before every state-changing action that depends on a
//! security. Every refusal is typed, carries a stable integer, and is emitted
//! as an on-chain event, because the refusal is the product: a venue that
//! declines to settle at Friday's close on a Sunday is worth more than one that
//! settles at a number nobody can defend.
//!
//! The order matters. The calendar is checked first because it is the cheapest,
//! the most deterministic, and the condition that holds about 81% of the week
//! (the regular session is 32.5 of 168 hours) — so the common case never
//! touches an oracle at all.

use anchor_lang::prelude::*;

use crate::calendar::{resolve_session, Session};
use crate::constants::{HALT_ATTESTATION_MAX_AGE_SECS, MULTIPLIER_QUIET_PERIOD_SECS};
use crate::error::{DeliverableError, RefusalCode};
use crate::oracle::{to_fixed, Observation, OracleSource};
use crate::scaled_ui::MintMultiplier;
use crate::state::MarketCalendar;

/// Attested halt state for a security.
///
/// A halt is the one condition no on-chain source can tell us: `PriceUpdateV2`
/// dropped the legacy `PriceStatus` enum, so halted, closed, outage and early
/// close are indistinguishable from staleness alone. It therefore arrives
/// signed by the registry's attestor and is stored, not inferred.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct HaltState {
    pub halted: bool,
    /// When the halt began, as reported by the source. Kept after the halt is
    /// lifted, because a settlement window has to be able to subtract the
    /// minutes it covered — otherwise clearing a halt erases the evidence that
    /// it was ever set.
    pub since_ts: i64,
    /// When the attestor signed it. Read, not decorative: an attestation older
    /// than [`crate::constants::HALT_ATTESTATION_MAX_AGE_SECS`] has stopped
    /// being a claim about the present and the gate stops honouring it.
    pub attested_ts: i64,
    /// Which feed the attestation came from.
    pub source: u8,
    /// When the halt stopped being in force, zero while it is in force. Set by
    /// an explicit clear; a halt that is simply never refreshed ends on its own
    /// at `attested_ts + HALT_ATTESTATION_MAX_AGE_SECS`.
    pub lifted_ts: i64,
}

impl HaltState {
    /// Whether this attestation is recent enough to be a claim about now.
    pub fn is_fresh(&self, now: i64) -> bool {
        now.saturating_sub(self.attested_ts) <= HALT_ATTESTATION_MAX_AGE_SECS
    }

    /// Whether the gate should refuse on this halt right now.
    pub fn is_in_force(&self, now: i64) -> bool {
        self.halted && self.is_fresh(now)
    }

    /// The interval this halt provably refused over, as far as durable state
    /// can prove it: `None` when there is nothing to subtract.
    ///
    /// This is what lets a settlement window be measured in *actionable*
    /// minutes without a keeper. A halt in force ran from `since_ts` until now;
    /// a halt nobody refreshed ran until its attestation went stale; a halt
    /// that was cleared ran until it was cleared. All three are reconstructible
    /// from the account after the fact, which is the property that matters —
    /// the attestor must not be able to erase the window it consumed by
    /// clearing the halt once the window is gone.
    pub fn refused_interval(&self, now: i64) -> Option<(i64, i64)> {
        if self.halted {
            let until = if self.is_fresh(now) {
                now
            } else {
                self.attested_ts.saturating_add(HALT_ATTESTATION_MAX_AGE_SECS)
            };
            Some((self.since_ts, until))
        } else if self.lifted_ts > 0 {
            Some((self.since_ts, self.lifted_ts))
        } else {
            None
        }
    }
}

#[event]
pub struct Refused {
    pub security: Pubkey,
    pub code: u8,
    pub at: i64,
}

/// Everything the gate needs, gathered by the caller so the gate itself reads
/// no accounts and can be unit-tested against any combination of conditions.
pub struct GateInputs<'a> {
    pub security: Pubkey,
    pub now: i64,
    pub calendar: &'a MarketCalendar,
    pub halt: HaltState,
    /// The mint's `Pausable` extension.
    pub mint_paused: bool,
    /// The mint's `transferHook.programId`, if it has become non-null.
    pub transfer_hook: Option<Pubkey>,
    pub multiplier: MintMultiplier,
    pub primary_source: OracleSource,
    pub primary: Observation,
    /// The corroborating source and what it printed. `None` only when the
    /// security was registered as [`crate::oracle::OracleBinding::SingleDeclared`],
    /// which the gate refuses on.
    pub secondary: Option<(OracleSource, Observation)>,
    pub max_age: u32,
    pub max_conf_bps: u32,
    pub max_divergence_bps: u32,
}

/// Run the gate and return the refusal, if any, without raising it.
///
/// Split out from [`assert_actionable`] because a transaction that refuses also
/// reverts, and a reverted instruction cannot write down that it refused.
/// `probe_security` needs the verdict as a value so the count survives.
pub fn check_actionable(g: &GateInputs) -> Result<Option<RefusalCode>> {
    #[allow(clippy::unnecessary_wraps)]
    fn refuse(code: RefusalCode) -> Result<Option<RefusalCode>> {
        Ok(Some(code))
    }

    if resolve_session(g.calendar, g.now) == Session::Closed {
        return refuse(RefusalCode::MarketClosed);
    }
    // A halt is only a refusal while somebody is still asserting it. One
    // `attest_halt(true)` used to block exercise on a security across every
    // series and every expiry forever, because `attested_ts` was written and
    // never read; holding a halt now costs a transaction an hour, in public.
    if g.halt.is_in_force(g.now) {
        return refuse(RefusalCode::Halted);
    }
    if g.mint_paused {
        return refuse(RefusalCode::IssuerPaused);
    }
    // Backed holds a live authority over the currently-empty transfer hook on
    // every xStock. If it is ever filled, arbitrary code runs on every
    // transfer; we refuse to transfer into unknown code rather than find out
    // what it does in production.
    if g.transfer_hook.is_some() {
        return refuse(RefusalCode::HookAttached);
    }
    if let Some((_, effective_ts)) = g.multiplier.pending {
        // Only the imminent ones. Issuers schedule dividend accruals weeks
        // ahead; refusing on any pending change at all would close the venue
        // for most of the year.
        if effective_ts.saturating_sub(g.now) <= MULTIPLIER_QUIET_PERIOD_SECS {
            return refuse(RefusalCode::MultiplierPending);
        }
    }
    if g.now.saturating_sub(g.primary.publish_ts) > g.max_age as i64 {
        return refuse(RefusalCode::OracleStale);
    }
    if let Some((_, second)) = &g.secondary {
        if g.now.saturating_sub(second.publish_ts) > g.max_age as i64 {
            return refuse(RefusalCode::OracleStale);
        }
    }

    // `ConfidenceBlown` means what it says: a source that publishes a band
    // published a wide one. Scope publishes no band at all, and a `conf` of
    // zero from it is an absence of information rather than a claim of
    // exactness — so the check simply does not apply to it, and the absence is
    // answered by the corroboration requirement below instead.
    if g.primary_source.reports_confidence() && conf_bps(&g.primary)? > g.max_conf_bps {
        return refuse(RefusalCode::ConfidenceBlown);
    }
    if let Some((source, obs)) = &g.secondary {
        if source.reports_confidence() && conf_bps(obs)? > g.max_conf_bps {
            return refuse(RefusalCode::ConfidenceBlown);
        }
    }

    // One number nothing can contradict is not a price, whoever published it.
    let Some((_, second)) = &g.secondary else {
        return refuse(RefusalCode::SingleSource);
    };
    if divergence_bps(&g.primary, second)? > g.max_divergence_bps {
        return refuse(RefusalCode::SourcesDisagree);
    }

    Ok(None)
}

/// The refusal gate proper: emit the code and fail the instruction.
pub fn assert_actionable(g: &GateInputs) -> Result<()> {
    match check_actionable(g)? {
        Some(code) => {
            emit_refusal(g.security, code, g.now);
            Err(error!(DeliverableError::from(code)))
        }
        None => Ok(()),
    }
}

/// Refuse on the calendar alone, before the caller has read any oracle.
///
/// `check_actionable` puts the calendar first, but it can only run once its
/// inputs exist, and building them means reading the price accounts. A Pyth
/// `PriceUpdateV2` that is simply old — which is the normal state of an equity
/// feed on a Sunday — fails inside `observe()` with `OracleStale` before the
/// gate is ever reached. That reports the wrong reason for the refusal and makes
/// a closed market depend on an oracle account being present and fresh. Callers
/// run this first so a closed market is decided by arithmetic and nothing else.
pub fn refuse_if_closed(security: Pubkey, calendar: &MarketCalendar, now: i64) -> Result<()> {
    if resolve_session(calendar, now) == Session::Closed {
        emit_refusal(security, RefusalCode::MarketClosed, now);
        return Err(error!(DeliverableError::MarketClosed));
    }
    Ok(())
}

/// A refusal is an on-chain artifact whether or not the transaction survives:
/// Solana records a failed transaction with its logs, so the event is there to
/// be linked either way.
pub fn emit_refusal(security: Pubkey, code: RefusalCode, at: i64) {
    emit!(Refused {
        security,
        code: code as u8,
        at,
    });
}

/// Reported confidence as a fraction of the price, in basis points.
pub fn conf_bps(o: &Observation) -> Result<u32> {
    require!(o.price > 0, DeliverableError::ConfidenceBlown);
    let bps = (o.conf as u128)
        .checked_mul(10_000)
        .ok_or(DeliverableError::MathOverflow)?
        / o.price as u128;
    Ok(u32::try_from(bps).unwrap_or(u32::MAX))
}

/// Distance between two observations in basis points of the first, normalised
/// so sources publishing different exponents can be compared.
pub fn divergence_bps(a: &Observation, b: &Observation) -> Result<u32> {
    let pa = to_fixed(a)?;
    let pb = to_fixed(b)?;
    require!(pa > 0, DeliverableError::ConfidenceBlown);
    let bps = pa
        .abs_diff(pb)
        .checked_mul(10_000)
        .ok_or(DeliverableError::MathOverflow)?
        / pa;
    Ok(u32::try_from(bps).unwrap_or(u32::MAX))
}
