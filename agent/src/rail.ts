/**
 * Reading the rail. Three numbers and one verdict, all through `@stocklana/sdk` so
 * the agent sees exactly what the program sees and nothing it does not.
 *
 *   1. the gate verdict      `isActionable` — the same nine-code gate as `gate.rs`
 *   2. the live price        the primary oracle observation, DIVIDED BY the multiplier
 *   3. the multiplier        the mint's effective ScaledUiAmount, plus any pending change
 *
 * Point 2 is the part everybody gets wrong, including the first version of this
 * repository's own measurement (see the README section that says so). Scope prices one
 * unscaled token. A strike, a spot and a premium are all quoted per *share*. One token
 * is `multiplier` shares. Dividing is not a refinement, it is the unit conversion, and
 * an agent that skips it is off by 32 bps on AAPLx and by a factor of ten on a name
 * that has split.
 */
import {
  observationToNumber,
  uiMultiplierAt,
  type ActionableResult,
  type Deliverable,
  type MintState,
} from '@stocklana/sdk';

import type { Underlying } from './underlyings.ts';

export interface RailRead {
  underlying: Underlying;
  /** The gate, evaluated off-chain on the accounts the program would read. */
  verdict: ActionableResult;
  mint: MintState;
  /** Scope's price for one unscaled token, USD. Null when the oracle read failed. */
  pricePerTokenUsd: number | null;
  /** The same price per adjusted share: `pricePerToken / multiplier`. */
  pricePerShareUsd: number | null;
  /** The multiplier the token program applies to UI amounts right now. */
  multiplier: number;
  /** A scheduled multiplier change that has not taken effect yet. */
  pendingMultiplier: { multiplier: number; effectiveTs: number } | null;
  /** Divergence between the two bound sources, bps, when there are two. */
  divergenceBps: number | null;
  evaluatedAt: number;
}

export async function readRail(
  d: Deliverable,
  underlying: Underlying,
  options: { preview?: boolean; at?: number } = {},
): Promise<RailRead> {
  const verdict = await d.isActionable(underlying.mint, {
    ...(options.preview === undefined ? {} : { preview: options.preview }),
    ...(options.at === undefined ? {} : { now: BigInt(options.at) }),
  });
  const mint = await d.getMint(underlying.mint);

  const at = verdict.evaluatedAt;
  const multiplier = uiMultiplierAt(mint.scaledUiAmount, at);

  const scaled = mint.scaledUiAmount;
  const pendingMultiplier =
    scaled && at < scaled.newMultiplierEffectiveTimestamp
      ? { multiplier: scaled.newMultiplier, effectiveTs: Number(scaled.newMultiplierEffectiveTimestamp) }
      : null;

  // The OracleStale early return in `isActionable` reports a zeroed observation rather
  // than a price, so a zero publish timestamp means "no read", not "priced at zero".
  const primary = verdict.observations.primary;
  const pricePerTokenUsd = primary.publishTs === 0n ? null : observationToNumber(primary);
  const secondary = verdict.observations.secondary;

  return {
    underlying,
    verdict,
    mint,
    pricePerTokenUsd,
    pricePerShareUsd: pricePerTokenUsd === null ? null : pricePerTokenUsd / multiplier,
    multiplier,
    pendingMultiplier,
    divergenceBps:
      pricePerTokenUsd === null || secondary === null || secondary.publishTs === 0n
        ? null
        : relativeBps(pricePerTokenUsd, observationToNumber(secondary)),
    evaluatedAt: Number(at),
  };
}

function relativeBps(a: number, b: number): number {
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? 0 : Math.round((Math.abs(a - b) / base) * 10_000);
}
