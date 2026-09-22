use anchor_lang::prelude::*;

// --- PDA seeds ---
#[constant]
pub const REGISTRY_SEED: &[u8] = b"registry";
#[constant]
pub const CALENDAR_SEED: &[u8] = b"calendar";
#[constant]
pub const SECURITY_SEED: &[u8] = b"security";
#[constant]
pub const SERIES_SEED: &[u8] = b"series";
#[constant]
pub const WRITER_SEED: &[u8] = b"writer";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const PREMIUM_SEED: &[u8] = b"premium";
#[constant]
pub const QUOTE_SEED: &[u8] = b"quote";
#[constant]
pub const OPTION_MINT_SEED: &[u8] = b"option";

/// Fixed-point scale for every multiplier and strike computation.
pub const SCALE: u128 = 1_000_000_000_000;

// --- US equity session, in minutes past local midnight (America/New_York) ---
pub const REGULAR_OPEN_MINUTE: u16 = 9 * 60 + 30;
pub const REGULAR_CLOSE_MINUTE: u16 = 16 * 60;

// --- gate defaults, overridable per security ---

/// A price older than this inside an open session is refused. Inside a regular
/// session Scope re-stamped the AAPLx and NVDAx entries every 41–43 s, and the
/// largest age observed was 44 s (sampled every 3 s, 2026-09-22 14:24–14:29
/// UTC), so a minute leaves about 16 s of headroom over a healthy feed.
pub const DEFAULT_MAX_PRICE_AGE_SECS: u32 = 60;

/// Refuse when reported confidence exceeds this fraction of the price.
/// Sources that report no confidence at all are handled explicitly, not by
/// letting a zero pass this check.
pub const DEFAULT_MAX_CONF_BPS: u32 = 100;

/// Refuse when two independent sources disagree by more than this.
pub const DEFAULT_MAX_DIVERGENCE_BPS: u32 = 150;

/// Upper bounds on the same two tolerances at registration.
///
/// They were bounded only from below, so `u32::MAX` was registrable for either
/// and made the corresponding refusal decorative for that security — with no
/// update instruction to undo it. A day of staleness and 50% divergence are
/// both already absurd; anything past them is not a tolerance, it is an opt-out.
pub const MAX_REGISTERED_PRICE_AGE_SECS: u32 = 86_400;
pub const MAX_REGISTERED_DIVERGENCE_BPS: u32 = 5_000;

/// Refuse for this long before a scheduled multiplier change takes effect, so a
/// contract cannot be settled into a corporate action that is already announced.
pub const MULTIPLIER_QUIET_PERIOD_SECS: i64 = 30 * 60;

/// How far a corporate action may move the multiplier between listing and
/// settlement before the venue refuses to re-cut the strike at all.
///
/// A thousandfold in either direction admits every corporate action in recorded
/// history — the largest real xStock multipliers are KLACX at 10.016833 and
/// VUGX at 6.004668 — and closes the case where the re-cut strike or the re-cut
/// UI size collapses far enough that physical delivery stops being priced by
/// anything. Without it the mint's `ScaledUiAmount` authority alone can convert
/// an open call into a free claim on collateral that is still worth full value.
pub const MAX_MULTIPLIER_BAND: u128 = 1_000;

/// How old a halt attestation may be before the gate stops honouring it.
///
/// A halt is a liveness signal, and an attestation nobody refreshes is not one.
/// Expiring it is what stops a single `attest_halt(true)` from blocking exercise
/// on a security forever: holding a halt now costs a transaction an hour, on
/// chain and in public, instead of one transaction ever.
pub const HALT_ATTESTATION_MAX_AGE_SECS: i64 = 3_600;

/// How far the session accumulator will walk forward before it gives up and
/// reports the window as long elapsed. Sixteen days covers the longest run of
/// consecutive closed days a US equity calendar can produce with room to spare,
/// and bounds the loop so a settlement call cannot be made expensive by waiting.
pub const MAX_SESSION_SCAN_DAYS: i64 = 16;

/// Longest settlement window a series may be listed with, in open-market
/// minutes.
///
/// Derived from [`MAX_SESSION_SCAN_DAYS`] rather than picked, so the two cannot
/// drift apart: the accumulator saturates once two instants are more than that
/// many calendar days apart, and the *fewest* weekdays sixteen consecutive
/// calendar days can contain is `16/7 * 5 = 10`, each at most a 390-minute
/// regular session. A window longer than the clock that measures it would
/// silently end early rather than refuse at listing. Holidays inside the stretch
/// can only shorten the real figure further, which is why the bound is the
/// weekday floor and not the observed maximum.
pub const MAX_SETTLEMENT_WINDOW_MINUTES: u16 =
    (MAX_SESSION_SCAN_DAYS as u16 / 7) * 5 * (REGULAR_CLOSE_MINUTE - REGULAR_OPEN_MINUTE);

/// Ceiling on a single series: enough for a real book, small enough that
/// `contracts * contract_raw_size` cannot approach a `u64` even for an
/// eight-decimal underlying.
pub const MAX_CONTRACTS_PER_SERIES: u64 = 1_000_000;

// --- mainnet accounts we read ---

/// Kamino Scope, which publishes the Chainlink-sourced xStocks prices that
/// tokenized-equity lending on Solana already marks against.
pub const SCOPE_PROGRAM: Pubkey = pubkey!("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");

/// The one `OraclePrices` account this program prices a Scope-bound security
/// from. Scope hosts several of these — five were live on 2026-09-22 — and the
/// entry at a given index means something different in each, so "owned by
/// Scope" is not an identity. Bound by address in `oracle::observe`.
pub const SCOPE_PRICES: Pubkey = pubkey!("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");

/// Offset of the first DatedPrice: 8-byte discriminator + 32-byte oracle_mappings.
pub const SCOPE_PRICES_OFFSET: usize = 40;
/// Size of one DatedPrice: value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64 | _[24].
pub const SCOPE_ENTRY_SIZE: usize = 56;
pub const SCOPE_MAX_ENTRIES: usize = 512;

/// Anchor account discriminator of Scope's `OraclePrices`, read off the live
/// account. Checked for the same reason the Pyth adapter checks its own: an
/// account of the right length under the right program is still not this type.
pub const SCOPE_ORACLE_PRICES_DISCRIMINATOR: [u8; 8] =
    [0x59, 0x80, 0x76, 0xdd, 0x06, 0x48, 0xb4, 0x92];

/// The exact length of an `OraclePrices`: the header plus all 512 entries.
/// The account is fixed-size, so anything else is not one.
pub const SCOPE_PRICES_LEN: usize = SCOPE_PRICES_OFFSET + SCOPE_MAX_ENTRIES * SCOPE_ENTRY_SIZE;
