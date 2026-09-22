//! One normalised price observation, whatever published it.
//!
//! US equity data is licensed, so the vendor a security marks against is a
//! procurement fact that can change without notice. An options venue whose
//! settlement depends on one vendor's licensing desk is not a venue, so the
//! refusal gate never learns which source it is reading: every adapter
//! normalises to [`Observation`] first.

pub mod pyth;
pub mod scope;

use anchor_lang::prelude::*;

use crate::constants::{SCOPE_PRICES, SCOPE_PROGRAM};
use crate::error::DeliverableError;
use crate::fixed::mul_div_floor;

/// A price as the gate sees it. `price * 10^expo` is the value in USD.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub struct Observation {
    pub price: i64,
    /// Half-width of the source's uncertainty band, in the same units as
    /// `price`. Zero from a source that publishes no band at all — see
    /// [`OracleSource::reports_confidence`], because zero is an absence of
    /// information and not a claim of exactness.
    pub conf: u64,
    pub expo: i32,
    pub publish_ts: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OracleSource {
    /// Kamino Scope, the Chainlink-sourced feed that the existing tokenized
    /// equity lending market on Solana already marks against. Permissionless to
    /// read, no key and no cranking cost.
    Scope { index: u16 },
    /// Pyth pull oracle. There is no standing equity feed account on Solana, so
    /// every read here is a price update somebody scheduled and paid for.
    Pyth { feed_id: [u8; 32], max_age: u32 },
}

impl OracleSource {
    /// Whether this source publishes a confidence band at all.
    ///
    /// Scope's `DatedPrice` has no confidence field. The gate has to know that
    /// the field is absent rather than zero, or a source that says nothing
    /// about its own uncertainty silently satisfies every bound.
    pub fn reports_confidence(&self) -> bool {
        matches!(self, OracleSource::Pyth { .. })
    }
}

/// What a security is allowed to be priced from.
///
/// Scope publishes several entries per name on one account, and two of them are
/// sourced differently: the `PythLazer` entry carries Pyth's own number, and the
/// `Checked` entry is a `CappedFloored` composition whose cap and floor come
/// from Chainlink — so once the bound binds, the two entries are genuinely two
/// vendors. Verified live on 2026-09-22: AAPLx `Checked` 317 printed 340.098163,
/// exactly the ChainlinkX entry at 258, while `PythLazer` 315 printed 340.670950.
/// Binding both is therefore the normal case, not a luxury.
///
/// A single source is representable, because one will sometimes be all there is,
/// but it has to be spelled out — and the gate still refuses to act on it. An
/// options venue that settles against one unfalsifiable number is a venue that
/// settles against whatever that number says.
#[derive(AnchorSerialize, AnchorDeserialize, InitSpace, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OracleBinding {
    /// Two independently-sourced entries, checked against each other.
    Pair {
        primary: OracleSource,
        secondary: OracleSource,
    },
    /// Declared single source. Readable, syncable, and not actionable.
    SingleDeclared { primary: OracleSource },
}

impl OracleBinding {
    pub fn primary(&self) -> OracleSource {
        match self {
            OracleBinding::Pair { primary, .. } => *primary,
            OracleBinding::SingleDeclared { primary } => *primary,
        }
    }

    pub fn secondary(&self) -> Option<OracleSource> {
        match self {
            OracleBinding::Pair { secondary, .. } => Some(*secondary),
            OracleBinding::SingleDeclared { .. } => None,
        }
    }
}

/// Read `acct` as this source and normalise it.
pub fn observe(source: &OracleSource, acct: &AccountInfo, now: i64) -> Result<Observation> {
    match source {
        OracleSource::Scope { index } => {
            // Address first, then owner. "Owned by Scope" identifies a program,
            // not an account: Scope hosts several `OraclePrices` feeds and the
            // same index carries an unrelated asset in each, so an owner check
            // alone accepts any of them — and any other Scope-owned account
            // type whose bytes happen to decode. The Pyth adapter binds its
            // account by `feed_id`; this is the same bind, by address.
            require_keys_eq!(
                acct.key(),
                SCOPE_PRICES,
                DeliverableError::OracleSourceMismatch
            );
            require_keys_eq!(
                *acct.owner,
                SCOPE_PROGRAM,
                DeliverableError::OracleSourceMismatch
            );
            let data = acct.try_borrow_data()?;
            scope::decode(&data, *index)
        }
        OracleSource::Pyth { feed_id, max_age } => pyth::observe(acct, feed_id, *max_age, now),
    }
}

/// `price * 10^expo` as a `u128` scaled by 1e12, so two observations published
/// with different exponents can be compared without touching a float.
pub fn to_fixed(o: &Observation) -> Result<u128> {
    // A zero or negative equity price is not a price. There is no refusal code
    // for "the feed printed nonsense", and the codes are frozen, so it lands in
    // the one that means we could not establish the price is usable.
    require!(o.price > 0, DeliverableError::ConfidenceBlown);
    let price = o.price as u128;
    if o.expo <= 0 {
        let d = pow10((-o.expo) as u32)?;
        mul_div_floor(price, crate::constants::SCALE, d)
    } else {
        let m = pow10(o.expo as u32)?;
        price
            .checked_mul(crate::constants::SCALE)
            .and_then(|v| v.checked_mul(m))
            .ok_or(DeliverableError::MathOverflow.into())
    }
}

fn pow10(n: u32) -> Result<u128> {
    require!(n <= 30, DeliverableError::MathOverflow);
    Ok(10u128.pow(n))
}
