import { describe, expect, it } from 'vitest';

import {
  civilFromDays,
  civilFromUnix,
  daysFromCivil,
  easternOffsetSeconds,
  nextOpen,
  openMinutesBetween,
  resolveSession,
  US_EQUITY_CALENDAR as cal,
} from '../src/calendar.js';
import { f64BitsToFixed, f64ToBits, f64ToFixed, mulDivCeil, mulDivFloor, SCALE } from '../src/fixed.js';
import { et } from './helpers.js';

// Ports of the #[cfg(test)] modules in fixed.rs and calendar.rs, so a divergence
// between the SDK and the program shows up as the same failing case on both sides.

describe('fixed.rs', () => {
  const AAPLX_OLD = 1.0026642075893797;
  const AAPLX_NEW = 1.0032690125398187;
  const NVDAX_NEW = 1.001701196801074;
  const KLACX = 10.016833;
  const VUGX = 6.004668;

  it('decodes real multipliers to within one unit of 1e12', () => {
    for (const v of [AAPLX_OLD, AAPLX_NEW, NVDAX_NEW, 10.0, 4.0, KLACX, VUGX, 1.0]) {
      const got = f64ToFixed(v);
      const want = BigInt(Math.round(v * 1e12));
      const diff = got > want ? got - want : want - got;
      expect(diff <= 1n, `v=${v} got=${got} want=${want}`).toBe(true);
    }
  });

  it('one is exactly the scale, and splits are exact integers', () => {
    expect(f64ToFixed(1.0)).toBe(SCALE);
    expect(f64ToFixed(10.0)).toBe(10n * SCALE);
    expect(f64ToFixed(4.0)).toBe(4n * SCALE);
  });

  it('rejects values a multiplier can never take', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1.0, 0.0]) {
      expect(() => f64ToFixed(bad)).toThrow();
    }
    expect(() => f64BitsToFixed(f64ToBits(2.2250738585072014e-308) >> 4n)).toThrow(); // subnormal
  });

  it('rounding directions bracket the true value', () => {
    expect([mulDivFloor(7n, SCALE, 3n * SCALE), mulDivCeil(7n, SCALE, 3n * SCALE)]).toEqual([2n, 3n]);
    expect([mulDivFloor(9n, SCALE, 3n * SCALE), mulDivCeil(9n, SCALE, 3n * SCALE)]).toEqual([3n, 3n]);
  });

  it('handles realistic magnitudes and refuses division by zero', () => {
    expect(mulDivFloor(1_000_000_000_000n, 10n * SCALE, SCALE)).toBe(10_000_000_000_000n);
    expect(() => mulDivFloor(1n, 1n, 0n)).toThrow();
    expect(() => mulDivCeil(1n, 1n, 0n)).toThrow();
  });
});

describe('calendar.rs', () => {
  it('civil dates round-trip', () => {
    for (const [y, m, d] of [
      [1970, 1, 1],
      [2000, 2, 29],
      [2026, 3, 8],
      [2026, 11, 1],
      [2026, 12, 31],
      [2027, 1, 1],
    ] as const) {
      expect(civilFromDays(daysFromCivil(y, m, d))).toEqual([y, m, d]);
    }
    expect(daysFromCivil(1970, 1, 1)).toBe(0);
  });

  it('DST boundaries are correct to the second', () => {
    expect(easternOffsetSeconds(1_772_953_199)).toBe(-5 * 3600);
    expect(easternOffsetSeconds(1_772_953_200)).toBe(-4 * 3600);
    expect(easternOffsetSeconds(1_793_512_799)).toBe(-4 * 3600);
    expect(easternOffsetSeconds(1_793_512_800)).toBe(-5 * 3600);
  });

  it('the regular session opens and closes on the minute', () => {
    expect(resolveSession(cal, et(2026, 9, 21, 9, 29))).toBe('Closed');
    expect(resolveSession(cal, et(2026, 9, 21, 9, 30))).toBe('Regular');
    expect(resolveSession(cal, et(2026, 9, 21, 15, 59))).toBe('Regular');
    expect(resolveSession(cal, et(2026, 9, 21, 16, 0))).toBe('Closed');
  });

  it('weekends, holidays and half days', () => {
    expect(resolveSession(cal, et(2026, 9, 20, 12, 0))).toBe('Closed');
    expect(resolveSession(cal, et(2026, 9, 19, 12, 0))).toBe('Closed');
    expect(resolveSession(cal, et(2026, 11, 27, 12, 59))).toBe('Regular');
    expect(resolveSession(cal, et(2026, 11, 27, 13, 0))).toBe('Closed');
    expect(resolveSession(cal, et(2026, 12, 24, 12, 59))).toBe('Regular');
    expect(resolveSession(cal, et(2026, 12, 24, 13, 0))).toBe('Closed');
    expect(resolveSession(cal, et(2026, 11, 27, 15, 0))).toBe('Closed');
    expect(resolveSession(cal, et(2026, 11, 26, 11, 0))).toBe('Closed');
    expect(resolveSession(cal, et(2026, 12, 25, 11, 0))).toBe('Closed');
    expect(resolveSession(cal, et(2027, 1, 1, 11, 0))).toBe('Closed');
  });

  it('the headline measurement window (2026-09-20 09:15Z) was closed', () => {
    expect(resolveSession(cal, 1_789_895_700)).toBe('Closed');
  });

  it('the session survives the spring-forward', () => {
    const fridayOpen = et(2026, 3, 6, 9, 30);
    const mondayOpen = et(2026, 3, 9, 9, 30);
    expect(resolveSession(cal, mondayOpen)).toBe('Regular');
    expect(resolveSession(cal, mondayOpen - 60)).toBe('Closed');
    expect(mondayOpen - fridayOpen).toBe(3 * 86_400 - 3600);
  });

  it('open minutes accumulate only while the market trades', () => {
    expect(openMinutesBetween(cal, et(2026, 9, 21, 10, 0), et(2026, 9, 21, 10, 30))).toBe(30);
    expect(openMinutesBetween(cal, et(2026, 9, 21, 8, 0), et(2026, 9, 21, 10, 0))).toBe(30);
    expect(openMinutesBetween(cal, et(2026, 9, 21, 0, 0), et(2026, 9, 22, 0, 0))).toBe(390);
    const friday = et(2026, 9, 18, 15, 55);
    expect(openMinutesBetween(cal, friday, et(2026, 9, 18, 16, 0))).toBe(5);
    expect(openMinutesBetween(cal, friday, et(2026, 9, 20, 12, 0))).toBe(5);
    expect(openMinutesBetween(cal, friday, et(2026, 9, 21, 9, 50))).toBe(25);
    const from = et(2026, 11, 25, 15, 30);
    expect(openMinutesBetween(cal, from, et(2026, 11, 26, 12, 0))).toBe(30);
    expect(openMinutesBetween(cal, from, et(2026, 11, 27, 15, 0))).toBe(30 + 210);
    const start = et(2026, 9, 21, 10, 0);
    expect(openMinutesBetween(cal, start, start + 400 * 86_400)).toBe(0xffff_ffff);
    expect(openMinutesBetween(cal, start, start)).toBe(0);
    expect(openMinutesBetween(cal, start, start - 1)).toBe(0);
  });

  it('reports Eastern, not UTC, civil time', () => {
    expect(civilFromUnix(et(2026, 9, 21, 9, 30))).toEqual([2026, 9, 21, 9 * 60 + 30]);
    expect(civilFromUnix(1_798_160_400)).toEqual([2026, 12, 24, 20 * 60]);
  });

  it('nextOpen skips the weekend and the Thanksgiving holiday', () => {
    expect(nextOpen(cal, et(2026, 9, 20, 5, 15))).toBe(et(2026, 9, 21, 9, 30));
    expect(nextOpen(cal, et(2026, 11, 25, 16, 30))).toBe(et(2026, 11, 27, 9, 30));
    const open = et(2026, 9, 21, 11, 0);
    expect(nextOpen(cal, open)).toBe(open);
  });
});
