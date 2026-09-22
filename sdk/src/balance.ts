/**
 * Multiplier-correct Token-2022 balances.
 *
 * The RPC does not agree with itself about ScaledUiAmount mints. `getTokenSupply`,
 * `getTokenAccountBalance` and jsonParsed account reads apply the multiplier to
 * `uiAmount`; `getTransaction`'s `meta.preTokenBalances` / `postTokenBalances` do not.
 * Verified on transaction 4rsX6HjrGb7i4WsG6yTVxnUZY1hyo3SLj3j2XbLXvid9Cn8s8tzk7SSEtra1yRrmvuxabtuaqZKkfaQynSJ6DCY:
 * the AAPLx balance there reports uiAmount 0.00439229 for raw 439229 at a multiplier
 * of 1.0032690125398187, while getTokenAccountBalance on the same account reports
 * 0.00440664.
 *
 * So nothing here trusts a reported `uiAmount`. Every figure is recomputed from the raw
 * amount and the multiplier in force at the relevant instant, and the reported figure
 * is kept alongside so the discrepancy is visible rather than silently corrected.
 */
import type { Address } from '@solana/kit';

import { uiMultiplierAt, type ScaledUiAmount } from './mint.js';

export type BalanceSource = 'token-account' | 'token-supply' | 'transaction' | 'raw';

/** How the multiplier used was established, so a caller can judge it. */
export type MultiplierProvenance =
  /** The mint has no ScaledUiAmount extension. */
  | 'no-extension'
  /** `at` is at or after `new_multiplier_effective_timestamp`: the mint's `new_multiplier`. */
  | 'mint:new_multiplier'
  /**
   * `at` is the present and a change is scheduled but not yet in force: the mint's
   * `multiplier` field, which is by construction the value in force now.
   */
  | 'mint:multiplier'
  /** Taken from the corporate-action history because `at` predates the mint's own record. */
  | 'history'
  /**
   * A past instant before the mint's latest change, with no history to bound it. The
   * mint's `multiplier` field is correct back to the previous change, whose date the
   * mint does not record.
   */
  | 'mint:multiplier-unbounded';

/** One multiplier change, as keeper/data/corporate-actions.json records it. */
export interface CorporateActionRecord {
  mint: string;
  newMultiplier: number;
  effectiveTimestamp: number;
  previousMultiplier?: number | null;
  previousEffectiveTimestamp?: number | null;
}

export interface MultiplierAt {
  multiplier: number;
  provenance: MultiplierProvenance;
}

/**
 * The float multiplier in force at `at`. The mint only remembers the latest change, so
 * a past instant before it is resolved from `history` when one is supplied. `current`
 * says `at` is the present, where the mint alone is authoritative.
 */
export function multiplierAt(
  mint: Address,
  scaled: ScaledUiAmount | null,
  at: bigint,
  options: { history?: readonly CorporateActionRecord[]; current?: boolean } = {},
): MultiplierAt {
  if (!scaled) return { multiplier: 1, provenance: 'no-extension' };
  if (at >= scaled.newMultiplierEffectiveTimestamp) {
    return { multiplier: scaled.newMultiplier, provenance: 'mint:new_multiplier' };
  }
  if (options.current) return { multiplier: scaled.multiplier, provenance: 'mint:multiplier' };

  const changes = (options.history ?? [])
    .filter((h) => h.mint === mint)
    .sort((a, b) => a.effectiveTimestamp - b.effectiveTimestamp);

  let inForce: CorporateActionRecord | undefined;
  for (const change of changes) {
    if (BigInt(change.effectiveTimestamp) <= at) inForce = change;
  }
  if (inForce) return { multiplier: inForce.newMultiplier, provenance: 'history' };

  // Before every recorded change: the earliest record's previous value, when the record
  // bounds it from below.
  const first = changes[0];
  if (first && first.previousMultiplier != null) {
    const bound = first.previousEffectiveTimestamp;
    if (bound == null || BigInt(bound) <= at) return { multiplier: first.previousMultiplier, provenance: 'history' };
  }
  return { multiplier: uiMultiplierAt(scaled, at), provenance: 'mint:multiplier-unbounded' };
}

/** What a source reported, kept verbatim for audit. */
export interface ReportedAmount {
  amount: string;
  decimals: number;
  uiAmount: number | null;
  uiAmountString: string;
}

export interface AdjustedBalance {
  /** Multiplier-correct UI amount: `raw / 10^decimals * multiplier`. */
  uiAmount: number;
  /**
   * The same value in the token program's own string convention
   * (`trunc(raw * multiplier)` shifted by `decimals`), which is exactly what
   * `getTokenAccountBalance` returns for a ScaledUiAmount mint.
   */
  uiAmountString: string;
  raw: bigint;
  decimals: number;
  multiplier: number;
  provenance: MultiplierProvenance;
  /** Unix seconds the multiplier was selected for. */
  at: bigint;
  mint: Address;
  source: BalanceSource;
  /** Present when the figure came from an RPC response that carried its own UI amount. */
  reported?: ReportedAmount;
  /**
   * Whether the reported UI amount already had the multiplier applied. `false` is the
   * transaction-meta bug; `null` when nothing was reported or the multiplier is 1.
   */
  reportedWasScaled?: boolean | null;
}

/** Integer `n` shifted `decimals` places, trailing zeros trimmed, as Agave formats UI strings. */
export function formatUnits(n: bigint, decimals: number): string {
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = decimals > 0 ? (abs % base).toString().padStart(decimals, '0').replace(/0+$/, '') : '';
  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** `trunc(raw * multiplier)` in raw units, the scaled amount the RPC formats. */
export function scaledRaw(raw: bigint, multiplier: number): bigint {
  return BigInt(Math.trunc(Number(raw) * multiplier));
}

export interface AdjustInput {
  raw: bigint;
  decimals: number;
  mint: Address;
  scaled: ScaledUiAmount | null;
  at: bigint;
  source: BalanceSource;
  history?: readonly CorporateActionRecord[];
  /** `at` is the present (a live balance or supply read), not a past instant. */
  current?: boolean;
  reported?: ReportedAmount;
}

/** The pure core of `getAdjustedBalance`: no network, every input explicit. */
export function adjustBalance(input: AdjustInput): AdjustedBalance {
  const { multiplier, provenance } = multiplierAt(input.mint, input.scaled, input.at, {
    ...(input.history ? { history: input.history } : {}),
    ...(input.current ? { current: true } : {}),
  });
  const uiAmount = (Number(input.raw) / 10 ** input.decimals) * multiplier;
  const uiAmountString = formatUnits(scaledRaw(input.raw, multiplier), input.decimals);

  const result: AdjustedBalance = {
    uiAmount,
    uiAmountString,
    raw: input.raw,
    decimals: input.decimals,
    multiplier,
    provenance,
    at: input.at,
    mint: input.mint,
    source: input.source,
  };

  if (input.reported) {
    result.reported = input.reported;
    const unscaled = formatUnits(input.raw, input.decimals);
    if (multiplier === 1 || uiAmountString === unscaled) {
      result.reportedWasScaled = null;
    } else if (input.reported.uiAmountString === uiAmountString) {
      result.reportedWasScaled = true;
    } else if (input.reported.uiAmountString === unscaled) {
      result.reportedWasScaled = false;
    } else {
      result.reportedWasScaled = null;
    }
  }
  return result;
}

/** A `pre/postTokenBalances` entry as `getTransaction` returns it. */
export interface TransactionTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: {
    amount: string;
    decimals: number;
    uiAmount: number | null;
    uiAmountString: string;
  };
}

/**
 * Correct one transaction-meta token balance. `blockTime` selects the multiplier; the
 * reported `uiAmount` is carried through but not used.
 */
export function adjustTransactionTokenBalance(
  balance: TransactionTokenBalance,
  scaled: ScaledUiAmount | null,
  blockTime: bigint,
  history?: readonly CorporateActionRecord[],
): AdjustedBalance {
  return adjustBalance({
    raw: BigInt(balance.uiTokenAmount.amount),
    decimals: balance.uiTokenAmount.decimals,
    mint: balance.mint as Address,
    scaled,
    at: blockTime,
    source: 'transaction',
    ...(history ? { history } : {}),
    reported: {
      amount: balance.uiTokenAmount.amount,
      decimals: balance.uiTokenAmount.decimals,
      uiAmount: balance.uiTokenAmount.uiAmount,
      uiAmountString: balance.uiTokenAmount.uiAmountString,
    },
  });
}
