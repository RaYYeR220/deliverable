//! Kamino Scope `OraclePrices` decode.
//!
//! Layout, verified against the live account
//! `3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH` (28,712 bytes):
//!
//! ```text
//! disc(8) | oracle_mappings(32) | DatedPrice[512]
//! DatedPrice = value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64 | _[24]
//! ```
//!
//! Entry *i* starts at `40 + i * 56` and the price is `value / 10^exp`.
//!
//! The account is what makes this rail cheap: permissionless to read from any
//! program, no key, no subscription, no cranking cost. It is also the reason
//! the gate consults the calendar first — the timestamp here advances every
//! slot through the weekend while the price underneath it has not moved since
//! Friday's close.

use anchor_lang::prelude::*;

use crate::constants::{
    SCOPE_ENTRY_SIZE, SCOPE_MAX_ENTRIES, SCOPE_ORACLE_PRICES_DISCRIMINATOR, SCOPE_PRICES_LEN,
    SCOPE_PRICES_OFFSET,
};
use crate::error::DeliverableError;

use super::Observation;

pub fn decode(data: &[u8], index: u16) -> Result<Observation> {
    let i = index as usize;
    require!(i < SCOPE_MAX_ENTRIES, DeliverableError::ScopeIndexOutOfRange);

    // `OraclePrices` is a fixed-size Anchor account, so its type is checkable
    // rather than inferable: exactly one length, and a discriminator in front.
    // A length check of "long enough for the index we want" accepted any
    // Scope-owned account of 18kB or more at index 332, which is how a feed we
    // never bound could answer for one we did.
    require!(
        data.len() == SCOPE_PRICES_LEN,
        DeliverableError::OracleSourceMismatch
    );
    require!(
        data[..8] == SCOPE_ORACLE_PRICES_DISCRIMINATOR,
        DeliverableError::OracleSourceMismatch
    );

    let start = SCOPE_PRICES_OFFSET + i * SCOPE_ENTRY_SIZE;

    let value = u64_at(data, start);
    let exp = u64_at(data, start + 8);
    let unix_timestamp = u64_at(data, start + 24);

    // An unwritten slot reads back as all zeroes; that is not a price.
    require!(value != 0, DeliverableError::OracleSourceMismatch);
    require!(exp <= 30, DeliverableError::MathOverflow);

    Ok(Observation {
        price: i64::try_from(value).map_err(|_| DeliverableError::MathOverflow)?,
        // Scope publishes no confidence field. Zero here means "this source
        // reports no confidence", and the gate treats it as such rather than
        // as a zero-width band.
        conf: 0,
        expo: -(exp as i32),
        publish_ts: i64::try_from(unix_timestamp).map_err(|_| DeliverableError::MathOverflow)?,
    })
}

fn u64_at(data: &[u8], offset: usize) -> u64 {
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&data[offset..offset + 8]);
    u64::from_le_bytes(buf)
}
