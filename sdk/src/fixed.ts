/**
 * Port of `programs/deliverable/src/fixed.rs`.
 *
 * The program never touches a float: it decodes the Token-2022 multiplier's IEEE-754
 * bits into a u128 scaled by 1e12 and stays in integers. Reproducing its numbers
 * off-chain therefore means reproducing that decode bit for bit, not multiplying JS
 * numbers, which is why everything here is bigint.
 */

/** `constants::SCALE`. */
export const SCALE = 1_000_000_000_000n;

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

/** Raised where the program would fail with a non-refusal `DeliverableError`. */
export class ProgramMathError extends Error {
  constructor(
    readonly variant: 'InvalidMultiplier' | 'MathOverflow',
    message: string,
  ) {
    super(message);
    this.name = 'ProgramMathError';
  }
}

/** The raw IEEE-754 bit pattern of a JS number, as the mint stores it. */
export function f64ToBits(value: number): bigint {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, true);
  return view.getBigUint64(0, true);
}

/**
 * `f64_bits_to_fixed`: decode to 1e12 fixed point, rounding to nearest. Rejects
 * negative, zero, subnormal, NaN and infinite values exactly as the program does.
 */
export function f64BitsToFixed(bits: bigint): bigint {
  const sign = bits >> 63n;
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & 0x000f_ffff_ffff_ffffn;

  if (sign !== 0n) throw new ProgramMathError('InvalidMultiplier', 'multiplier is negative');
  if (exp === 0x7ff) throw new ProgramMathError('InvalidMultiplier', 'multiplier is NaN or infinite');
  if (exp === 0) throw new ProgramMathError('InvalidMultiplier', 'multiplier is zero or subnormal');

  const mantissa = (1n << 52n) | frac;
  const shift = exp - 1023 - 52;
  const scaled = mantissa * SCALE;
  if (scaled > U128_MAX) throw new ProgramMathError('MathOverflow', 'mantissa overflowed u128');

  let out: bigint;
  if (shift >= 0) {
    if (shift >= 64) throw new ProgramMathError('InvalidMultiplier', 'multiplier exponent out of range');
    out = scaled << BigInt(shift);
    // checked_shl only rejects shift >= 128; bits shifted past u128 are dropped, which
    // cannot happen for the exponents a multiplier takes but is mirrored anyway.
    out &= U128_MAX;
  } else {
    const s = -shift;
    if (s >= 128) throw new ProgramMathError('InvalidMultiplier', 'multiplier exponent out of range');
    const half = 1n << BigInt(s - 1);
    const sum = scaled + half;
    if (sum > U128_MAX) throw new ProgramMathError('MathOverflow', 'rounding overflowed u128');
    out = sum >> BigInt(s);
  }

  if (out <= 0n) throw new ProgramMathError('InvalidMultiplier', 'multiplier rounds to zero');
  return out;
}

export function f64ToFixed(value: number): bigint {
  return f64BitsToFixed(f64ToBits(value));
}

function checkedMul(a: bigint, b: bigint): bigint {
  const product = a * b;
  if (product > U128_MAX) throw new ProgramMathError('MathOverflow', 'u128 multiplication overflowed');
  return product;
}

/** `mul_div_floor`: `a * b / d`, rounding down, in u128. */
export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new ProgramMathError('MathOverflow', 'division by zero');
  return checkedMul(a, b) / d;
}

/** `mul_div_ceil`: `a * b / d`, rounding up, in u128. */
export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new ProgramMathError('MathOverflow', 'division by zero');
  const product = checkedMul(a, b);
  return (product + d - 1n) / d;
}

/** `u64::try_from(..).map_err(|_| MathOverflow)`. */
export function toU64(value: bigint): bigint {
  if (value < 0n || value > U64_MAX) throw new ProgramMathError('MathOverflow', 'value does not fit in u64');
  return value;
}

/** A 1e12 fixed-point value rendered as a decimal string, for display only. */
export function formatFixed(value: bigint, places = 12): string {
  const whole = value / SCALE;
  const frac = (value % SCALE).toString().padStart(12, '0').slice(0, places).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}
