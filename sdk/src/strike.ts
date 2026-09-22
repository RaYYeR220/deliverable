/**
 * The adjustment invariant, as `OptionSeries` in state/series.rs computes it:
 *
 *   strike  = strike0 * m0 / m1        (floor, against the writer)
 *   ui_size = raw_size * m1 / SCALE     (floor)
 *
 * so `strike * ui_size` does not move when the multiplier does. m0 is frozen on the
 * series at creation; m1 is read off the mint at the instant asked about.
 */
import { openMinutesBetween, type CalendarLike } from './calendar.js';
import { mulDivCeil, mulDivFloor, SCALE, toU64 } from './fixed.js';
import { mintMultiplierAt, type MintState } from './mint.js';

/** The `OptionSeries` fields the strike math reads. The decoded account satisfies it. */
export interface SeriesTerms {
  strike0: bigint;
  multiplierAtMint: bigint;
  contractRawSize: bigint;
  adjustOnCorporateAction: boolean;
  underlyingDecimals: number;
}

/** `OptionSeries::current_strike`. */
export function strikeAt(series: SeriesTerms, m1: bigint): bigint {
  if (!series.adjustOnCorporateAction) return series.strike0;
  return toU64(mulDivFloor(series.strike0, series.multiplierAtMint, m1));
}

/** `OptionSeries::current_ui_size`, in raw units of the underlying's decimals. */
export function uiSizeAt(series: SeriesTerms, m1: bigint): bigint {
  return mulDivFloor(series.contractRawSize, m1, SCALE);
}

/** `OptionSeries::exercise_cost`: quote units to exercise `contracts`, rounded up. */
export function exerciseCostAt(series: SeriesTerms, m1: bigint, contracts: bigint): bigint {
  const strike = strikeAt(series, m1);
  const uiSize = uiSizeAt(series, m1);
  const grid = 10n ** BigInt(series.underlyingDecimals);
  const perContract = mulDivCeil(strike, uiSize, grid);
  return toU64(perContract * contracts);
}

export interface CurrentStrike {
  /** Quote units per adjusted share, as the program would charge it now. */
  strike: bigint;
  strike0: bigint;
  /** m0, frozen at creation, 1e12 fixed point. */
  multiplierAtMint: bigint;
  /** m1, read off the mint at `at`, 1e12 fixed point. */
  multiplier: bigint;
  /** Raw units of the underlying's decimals one contract now represents in UI terms. */
  uiSize: bigint;
  /** `strike * uiSize`: the invariant. */
  notional: bigint;
  adjusted: boolean;
  at: bigint;
}

/**
 * The strike a series carries right now, derived from the mint's live multiplier the
 * same way `exercise` derives it in the same transaction. `mint` is a decoded mint
 * account; `Deliverable.currentStrike` fetches one.
 */
export function currentStrike(series: SeriesTerms, mint: MintState, at: bigint = BigInt(Math.floor(Date.now() / 1000))): CurrentStrike {
  if (!mint.scaledUiAmount) {
    throw new Error(`mint ${mint.address} has no ScaledUiAmount extension; the program refuses to price it`);
  }
  const m1 = mintMultiplierAt(mint.scaledUiAmount, at).effective;
  const strike = strikeAt(series, m1);
  const uiSize = uiSizeAt(series, m1);
  return {
    strike,
    strike0: series.strike0,
    multiplierAtMint: series.multiplierAtMint,
    multiplier: m1,
    uiSize,
    notional: strike * uiSize,
    adjusted: series.adjustOnCorporateAction && m1 !== series.multiplierAtMint,
    at,
  };
}

export type SeriesPhase = 'Active' | 'Settling' | 'Settled';

/** `OptionSeries::phase`: derived from the clock and the calendar, never stored. */
export function seriesPhase(
  series: { expiryTs: bigint; settlementWindowMinutes: number },
  calendar: CalendarLike,
  now: bigint,
): SeriesPhase {
  if (now < series.expiryTs) return 'Active';
  const elapsed = openMinutesBetween(calendar, Number(series.expiryTs), Number(now));
  return elapsed < series.settlementWindowMinutes ? 'Settling' : 'Settled';
}
