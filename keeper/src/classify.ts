/**
 * xStocks express every corporate action as a ScaledUiAmount multiplier change, with no
 * label attached. The ratio is the only signal, so classification is a heuristic and is
 * reported as such — `confidence` is there to stop downstream code treating it as truth.
 */
export type ActionKind = 'none' | 'dividend' | 'split' | 'reverse-split' | 'adjustment';

export interface Classification {
  kind: ActionKind;
  ratio: number;
  percentChange: number;
  confidence: 'high' | 'medium' | 'low';
  note: string;
}

/** Below this the move is rounding noise from the issuer's own accounting. */
const NOISE = 1e-9;
/** A cash dividend on an equity is a sub-percent NAV step; 5% is a generous ceiling. */
const DIVIDEND_CEILING = 0.05;
/** Splits are announced as whole or half ratios (2:1, 3:1, 10:1, 3:2). */
const SPLIT_FLOOR = 1.4;

function isNearRoundRatio(ratio: number): boolean {
  const doubled = ratio * 2;
  return Math.abs(doubled - Math.round(doubled)) < 0.01;
}

export function classify(previous: number, next: number): Classification {
  const ratio = previous === 0 ? Number.NaN : next / previous;
  const percentChange = (ratio - 1) * 100;

  if (!Number.isFinite(ratio)) {
    return { kind: 'adjustment', ratio, percentChange, confidence: 'low', note: 'previous multiplier was zero' };
  }

  if (Math.abs(ratio - 1) < NOISE) {
    return { kind: 'none', ratio, percentChange, confidence: 'high', note: 'multiplier unchanged' };
  }

  if (ratio > 1 && ratio - 1 <= DIVIDEND_CEILING) {
    return {
      kind: 'dividend',
      ratio,
      percentChange,
      confidence: ratio - 1 < 0.02 ? 'high' : 'medium',
      note: `holders gain ${percentChange.toFixed(4)}% of units; consistent with a cash distribution reinvested into the wrapper`,
    };
  }

  if (ratio >= SPLIT_FLOOR) {
    return {
      kind: 'split',
      ratio,
      percentChange,
      confidence: isNearRoundRatio(ratio) ? 'high' : 'medium',
      note: `forward split, approximately ${formatRatio(ratio)}`,
    };
  }

  if (ratio > 0 && ratio <= 1 / SPLIT_FLOOR) {
    return {
      kind: 'reverse-split',
      ratio,
      percentChange,
      confidence: isNearRoundRatio(1 / ratio) ? 'high' : 'medium',
      note: `reverse split, approximately 1:${(1 / ratio).toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`,
    };
  }

  return {
    kind: 'adjustment',
    ratio,
    percentChange,
    confidence: 'low',
    note: 'move is too large for a distribution and too small for a split',
  };
}

function formatRatio(ratio: number): string {
  const rounded = Math.round(ratio * 2) / 2;
  if (Math.abs(rounded - ratio) > 0.01) return `${ratio.toFixed(4)}:1`;
  return Number.isInteger(rounded) ? `${rounded}:1` : `${rounded * 2}:2`;
}

/**
 * A mint that has never had a corporate action sits at multiplier exactly 1.0 with an
 * effective timestamp of 0, which is the state `InitializeScaledUiAmountMint` leaves behind.
 */
export function isPristine(multiplier: number, effectiveTimestamp: number): boolean {
  return multiplier === 1 && effectiveTimestamp === 0;
}
