use crate::fixed::f64_bits_to_fixed;
use crate::scaled_ui::{effective_from_cfg, parse_scaled_ui};

use super::harness::{AAPLX_EFFECTIVE_TS, AAPLX_MINT_DATA, AAPLX_MULTIPLIER, AAPLX_NEW_MULTIPLIER};

/// The extension's own accessors (`current_multiplier` / `total_multiplier`)
/// are private in spl-token-2022-interface, so we re-implement the rule and pin
/// it against the real account.
#[test]
fn effective_multiplier_flips_at_the_effective_timestamp() {
    let cfg = parse_scaled_ui(AAPLX_MINT_DATA).unwrap();

    let before = effective_from_cfg(&cfg, AAPLX_EFFECTIVE_TS - 1).unwrap();
    let at = effective_from_cfg(&cfg, AAPLX_EFFECTIVE_TS).unwrap();
    let after = effective_from_cfg(&cfg, 1_789_850_898).unwrap();

    assert_eq!(
        before.effective,
        f64_bits_to_fixed(AAPLX_MULTIPLIER.to_bits()).unwrap()
    );
    assert_eq!(
        at.effective,
        f64_bits_to_fixed(AAPLX_NEW_MULTIPLIER.to_bits()).unwrap()
    );
    assert_eq!(after.effective, at.effective);
    assert!(before.pending.is_some());
    assert!(after.pending.is_none());
}

#[test]
fn wire_order_is_authority_multiplier_timestamp_new_multiplier() {
    // Guards against the field order trap: the effective timestamp sits BETWEEN
    // the two multipliers, not after them. Read in the wrong order this field
    // comes back as the bit pattern of 1.0032690125398187, which is 4.6e18.
    let cfg = parse_scaled_ui(AAPLX_MINT_DATA).unwrap();
    let effective_ts: i64 = cfg.new_multiplier_effective_timestamp.into();
    assert_eq!(effective_ts, AAPLX_EFFECTIVE_TS);

    let transposed = i64::from_le_bytes(cfg.new_multiplier.0);
    assert_ne!(transposed, AAPLX_EFFECTIVE_TS);
    assert!(transposed > 4_000_000_000_000_000_000);
}

#[test]
fn epoch_key_moves_only_when_the_effective_multiplier_does() {
    let cfg = parse_scaled_ui(AAPLX_MINT_DATA).unwrap();

    let before = effective_from_cfg(&cfg, AAPLX_EFFECTIVE_TS - 1).unwrap();
    let at = effective_from_cfg(&cfg, AAPLX_EFFECTIVE_TS).unwrap();
    let much_later = effective_from_cfg(&cfg, AAPLX_EFFECTIVE_TS + 90 * 86_400).unwrap();

    assert_ne!(before.epoch_key, at.epoch_key);
    assert_eq!(at.epoch_key, much_later.epoch_key);
}

#[test]
fn pending_carries_the_value_and_the_time_it_lands() {
    let cfg = parse_scaled_ui(AAPLX_MINT_DATA).unwrap();
    let before = effective_from_cfg(&cfg, AAPLX_EFFECTIVE_TS - 3600).unwrap();

    let (value, at) = before.pending.unwrap();
    assert_eq!(value, f64_bits_to_fixed(AAPLX_NEW_MULTIPLIER.to_bits()).unwrap());
    assert_eq!(at, AAPLX_EFFECTIVE_TS);
    // AAPLx's pending step is a dividend accrual: +6.0 bps, not a split.
    assert!(value > before.effective);
    assert!(value - before.effective < before.effective / 1_000);
}

#[test]
fn a_mint_without_the_extension_is_refused() {
    // The Pyth price update is not a mint at all; the unpack must fail rather
    // than read whatever happens to sit at the extension offset.
    assert!(parse_scaled_ui(super::harness::PYTH_UPDATE_DATA).is_err());
}
