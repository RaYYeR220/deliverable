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

/// A price older than this inside an open session is refused. Scope refreshes
/// every few slots while US markets are open, so a minute is generous.
pub const DEFAULT_MAX_PRICE_AGE_SECS: u32 = 60;

/// Refuse when reported confidence exceeds this fraction of the price.
/// Sources that report no confidence at all are handled explicitly, not by
/// letting a zero pass this check.
pub const DEFAULT_MAX_CONF_BPS: u32 = 100;

/// Refuse when two independent sources disagree by more than this.
pub const DEFAULT_MAX_DIVERGENCE_BPS: u32 = 150;

/// Refuse for this long before a scheduled multiplier change takes effect, so a
/// contract cannot be settled into a corporate action that is already announced.
pub const MULTIPLIER_QUIET_PERIOD_SECS: i64 = 30 * 60;

/// Default settlement window, in minutes of open-market time.
pub const DEFAULT_SETTLEMENT_WINDOW_MINUTES: u16 = 30;

/// How far the session accumulator will walk forward before it gives up and
/// reports the window as long elapsed. Sixteen days covers the longest run of
/// consecutive closed days a US equity calendar can produce with room to spare,
/// and bounds the loop so a settlement call cannot be made expensive by waiting.
pub const MAX_SESSION_SCAN_DAYS: i64 = 16;

/// Ceiling on a single series: enough for a real book, small enough that
/// `contracts * contract_raw_size` cannot approach a `u64` even for an
/// eight-decimal underlying.
pub const MAX_CONTRACTS_PER_SERIES: u64 = 1_000_000;

// --- mainnet accounts we read ---

/// Kamino Scope, which publishes the Chainlink-sourced xStocks prices that
/// tokenized-equity lending on Solana already marks against.
pub const SCOPE_PROGRAM: Pubkey = pubkey!("HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ");
pub const SCOPE_PRICES: Pubkey = pubkey!("3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH");

/// Offset of the first DatedPrice: 8-byte discriminator + 32-byte oracle_mappings.
pub const SCOPE_PRICES_OFFSET: usize = 40;
/// Size of one DatedPrice: value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64 | _[24].
pub const SCOPE_ENTRY_SIZE: usize = 56;
pub const SCOPE_MAX_ENTRIES: usize = 512;
