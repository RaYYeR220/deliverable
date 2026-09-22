//! Fixed-point arithmetic for multiplier and strike math.
//!
//! The Token-2022 ScaledUiAmount extension stores its multiplier as an IEEE-754
//! `f64`. Float arithmetic does work on SBPF, but we decode the bits into a
//! `u128` scaled by 1e12 and stay in integers from there, so every number the
//! program produces is reproducible byte-for-byte by an off-chain checker and
//! the rounding direction is something we chose rather than inherited.

use anchor_lang::prelude::*;

use crate::constants::SCALE;
use crate::error::DeliverableError;

/// Decode an IEEE-754 `f64` bit pattern into a `u128` scaled by 1e12,
/// rounding to nearest.
///
/// Rejects anything a multiplier must never be: negative, zero, subnormal,
/// NaN or infinite. A mint whose multiplier is any of those is not a security
/// we can price, and refusing here is cheaper than discovering it at settlement.
pub fn f64_bits_to_fixed(bits: u64) -> Result<u128> {
    let sign = bits >> 63;
    let exp = ((bits >> 52) & 0x7ff) as i32;
    let frac = bits & 0x000f_ffff_ffff_ffff;

    require!(sign == 0, DeliverableError::InvalidMultiplier);
    require!(exp != 0x7ff, DeliverableError::InvalidMultiplier);
    require!(exp != 0, DeliverableError::InvalidMultiplier);

    // value = (1 + frac/2^52) * 2^(exp-1023) = mantissa * 2^(exp-1023-52)
    let mantissa = (1u128 << 52) | frac as u128;
    let shift = exp - 1023 - 52;

    let scaled = mantissa
        .checked_mul(SCALE)
        .ok_or(DeliverableError::MathOverflow)?;

    let out = if shift >= 0 {
        require!(shift < 64, DeliverableError::InvalidMultiplier);
        scaled
            .checked_shl(shift as u32)
            .ok_or(DeliverableError::MathOverflow)?
    } else {
        let s = (-shift) as u32;
        require!(s < 128, DeliverableError::InvalidMultiplier);
        // round to nearest rather than truncate
        let half = 1u128 << (s - 1);
        scaled
            .checked_add(half)
            .ok_or(DeliverableError::MathOverflow)?
            >> s
    };

    require!(out > 0, DeliverableError::InvalidMultiplier);
    Ok(out)
}

/// `a * b / d`, rounding down. Used where rounding must not favour the caller.
pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Result<u128> {
    require!(d != 0, DeliverableError::MathOverflow);
    Ok(a.checked_mul(b)
        .ok_or(DeliverableError::MathOverflow)?
        / d)
}

/// `a * b / d`, rounding up. Used where the protocol must not under-collect.
pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Result<u128> {
    require!(d != 0, DeliverableError::MathOverflow);
    Ok(a.checked_mul(b)
        .ok_or(DeliverableError::MathOverflow)?
        .div_ceil(d))
}

#[cfg(test)]
mod tests {
    use super::*;

    // Multipliers read from Solana mainnet on 2026-09-20.
    const AAPLX_OLD: f64 = 1.0026642075893797;
    const AAPLX_NEW: f64 = 1.0032690125398187;
    const NVDAX_NEW: f64 = 1.0017011968010740;
    const NFLXX_SPLIT: f64 = 10.0; // Netflix 10-for-1, 2025-11-16
    const CRWDX_SPLIT: f64 = 4.0; // CrowdStrike 4-for-1, 2026-07-02
    const KLACX: f64 = 10.016833; // 10-for-1 plus accrued dividends
    const VUGX: f64 = 6.004668; // 6-for-1 ETF split plus dividends

    #[test]
    fn decodes_real_multipliers() {
        for v in [
            AAPLX_OLD, AAPLX_NEW, NVDAX_NEW, NFLXX_SPLIT, CRWDX_SPLIT, KLACX, VUGX, 1.0,
        ] {
            let got = f64_bits_to_fixed(v.to_bits()).unwrap();
            let want = (v * SCALE as f64).round() as u128;
            assert!(
                got.abs_diff(want) <= 1,
                "v={v} got={got} want={want} (diff {})",
                got.abs_diff(want)
            );
        }
    }

    #[test]
    fn one_is_exactly_the_scale() {
        assert_eq!(f64_bits_to_fixed(1.0f64.to_bits()).unwrap(), SCALE);
    }

    #[test]
    fn splits_are_exact_integers() {
        assert_eq!(f64_bits_to_fixed(NFLXX_SPLIT.to_bits()).unwrap(), 10 * SCALE);
        assert_eq!(f64_bits_to_fixed(CRWDX_SPLIT.to_bits()).unwrap(), 4 * SCALE);
    }

    #[test]
    fn rejects_values_a_multiplier_can_never_take() {
        assert!(f64_bits_to_fixed(f64::NAN.to_bits()).is_err());
        assert!(f64_bits_to_fixed(f64::INFINITY.to_bits()).is_err());
        assert!(f64_bits_to_fixed(f64::NEG_INFINITY.to_bits()).is_err());
        assert!(f64_bits_to_fixed((-1.0f64).to_bits()).is_err());
        assert!(f64_bits_to_fixed(0.0f64.to_bits()).is_err());
        assert!(f64_bits_to_fixed(f64::MIN_POSITIVE.to_bits() >> 4).is_err()); // subnormal
    }

    #[test]
    fn rounding_directions_bracket_the_true_value() {
        let f = mul_div_floor(7, SCALE, 3 * SCALE).unwrap();
        let c = mul_div_ceil(7, SCALE, 3 * SCALE).unwrap();
        assert_eq!((f, c), (2, 3));
    }

    #[test]
    fn exact_division_agrees_in_both_directions() {
        let f = mul_div_floor(9, SCALE, 3 * SCALE).unwrap();
        let c = mul_div_ceil(9, SCALE, 3 * SCALE).unwrap();
        assert_eq!((f, c), (3, 3));
    }

    #[test]
    fn handles_realistic_magnitudes_without_overflow() {
        // a trillion raw units against a 10x split
        let r = mul_div_floor(1_000_000_000_000u128, 10 * SCALE, SCALE).unwrap();
        assert_eq!(r, 10_000_000_000_000u128);
    }

    #[test]
    fn division_by_zero_is_an_error_not_a_panic() {
        assert!(mul_div_floor(1, 1, 0).is_err());
        assert!(mul_div_ceil(1, 1, 0).is_err());
    }
}
