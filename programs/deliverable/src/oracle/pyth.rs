//! Pyth pull-oracle read.
//!
//! There is no standing Pyth equity feed account on Solana: the canonical
//! shard-0 PDAs for the names we cover do not exist, so every equity price read
//! is a `PriceUpdateV2` somebody posted and paid for in the same transaction.
//! That is a cost, not a defect — a posted update is verifiably fresh in a way
//! a permanently-live account is not.

use anchor_lang::prelude::*;
use anchor_lang::Discriminator;
use pyth_solana_receiver_sdk::price_update::{FeedId, PriceUpdateV2};

use crate::error::DeliverableError;

use super::Observation;

/// Read a verified `PriceUpdateV2` for `feed_id`.
///
/// The owner and discriminator checks are the ones `Account<'info,
/// PriceUpdateV2>` performs; we do them by hand because that type borrows the
/// account for `'info` and this adapter is called with a plain reference, so
/// every source can be read behind one signature.
///
/// `max_age` here is the outer bound past which the account is not a price at
/// all and the read fails hard. The gate applies the security's own, tighter
/// staleness tolerance afterwards, because that one has to come back as a typed
/// refusal with an event rather than a decode failure.
pub fn observe(
    acct: &AccountInfo,
    feed_id: &[u8; 32],
    max_age: u32,
    now: i64,
) -> Result<Observation> {
    require_keys_eq!(
        *acct.owner,
        PriceUpdateV2::owner(),
        DeliverableError::OracleSourceMismatch
    );

    let data = acct.try_borrow_data()?;
    require!(
        data.len() > 8 && data[..8] == *PriceUpdateV2::DISCRIMINATOR,
        DeliverableError::OracleSourceMismatch
    );
    let update = PriceUpdateV2::deserialize(&mut &data[8..])
        .map_err(|_| error!(DeliverableError::OracleSourceMismatch))?;

    // `get_price_no_older_than` also insists on Full Wormhole verification. A
    // partially-verified update lowers the number of guardians that have to
    // collude to move a settlement price, so we do not accept one.
    let clock = Clock {
        unix_timestamp: now,
        ..Clock::default()
    };
    let price = update
        .get_price_no_older_than(&clock, max_age as u64, feed_id as &FeedId)
        .map_err(|_| error!(DeliverableError::OracleStale))?;

    Ok(Observation {
        price: price.price,
        conf: price.conf,
        expo: price.exponent,
        publish_ts: price.publish_time,
    })
}
