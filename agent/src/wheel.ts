/**
 * The decision. Pure: it takes a gate verdict, a spot, the series that already exist
 * and the collateral available, and returns what the wheel would do and why.
 *
 * ONE RULE OUTRANKS EVERY OTHER RULE IN THIS FILE.
 *
 * If the gate refuses, the wheel proposes nothing. Not a smaller size, not a wider
 * strike, not "the market reopens in four hours so this is fine". `planWheel` returns
 * `proposals: []` and a decision of kind `refuse` carrying the code, the Anchor error
 * number the instruction would fail with, and what a caller should do about it. An
 * agent that trades into a closed or halted market is the failure this whole project
 * exists to prevent, and `test/refusal.test.ts` drives all nine codes through the
 * program's own ported gate and asserts exactly this.
 *
 * The gate verdict is `GateVerdict` from the SDK, which is what `checkActionable`
 * returns — the line-for-line port of `gate.rs`. The agent does not get its own
 * opinion of whether a market is open.
 */
import { REFUSALS, RefusalCode, type GateVerdict, type RefusalCodeValue, type RefusalInfo } from '@stocklana/sdk';

import type { OpenSeries } from './series.ts';
import type { Underlying } from './underlyings.ts';
import { annualise, buildLadder, quoteRung, type PremiumYield, type Rung } from './yield.ts';

export interface WheelParameters {
  /** Annualised premium yield a rung must clear before the wheel will write it. */
  hurdleAnnualised: number;
  /** Strike ladder, as K/S. */
  moneyness: readonly number[];
  /** Tenors to consider, in days. */
  tenorDays: readonly number[];
  /** Roll an open series once it has fewer than this many days left. */
  rollWithinDays: number;
  riskFreeRate: number;
  /** Underlying shares per contract. */
  contractSize: number;
  /** Contracts in a new series, i.e. the whole token supply. Bounded by collateral. */
  contracts: number;
  /** Inventory vol markup at full size, passed to the curve. */
  inventoryVolPremium: number;
}

export const DEFAULT_WHEEL: WheelParameters = Object.freeze({
  hurdleAnnualised: 0.12,
  moneyness: Object.freeze([1.02, 1.05, 1.1]),
  tenorDays: Object.freeze([7, 14, 30, 45]),
  rollWithinDays: 7,
  riskFreeRate: 0,
  contractSize: 1,
  contracts: 1000,
  inventoryVolPremium: 0.5,
});

/**
 * What an agent should do about each refusal. This table is the machine-readable half
 * of `SKILL.md`, and the two are the same nine sentences on purpose.
 */
export const REFUSAL_GUIDANCE: Readonly<Record<RefusalCodeValue, string>> = Object.freeze({
  [RefusalCode.MarketClosed]:
    'Wait. This is the expected state for about 81% of the week and says nothing is wrong. Re-read at the next regular open, which the verdict gives you as nextOpen.',
  [RefusalCode.Halted]:
    'Stop and do not retry on a timer. A halt is attested, not computed, so it clears when the attestor says so and not before. Escalate rather than poll.',
  [RefusalCode.OracleStale]:
    'Do not fall back to the last price. Inside an open session staleness means an outage, not a closed market. Retry once the source publishes; if it persists, treat the security as unpriceable.',
  [RefusalCode.ConfidenceBlown]:
    'Wait for the band to narrow. Widen nothing: the tolerance is the security\'s own registered maxConfBps and an agent that raises it is choosing to trade on a number the venue already called unusable.',
  [RefusalCode.MultiplierPending]:
    'Wait out the quiet period, then re-read the strike. A dividend, split or reverse split is about to change the unit, and every strike on this name is about to be re-cut by m0/m1. Acting inside the window prices in the old unit and settles in the new one.',
  [RefusalCode.IssuerPaused]:
    'Stop. The issuer has frozen the mint; no transfer of the collateral can settle. This is an issuer action and no amount of retrying moves it.',
  [RefusalCode.HookAttached]:
    'Stop permanently until reviewed by a human. Every xStock ships an initialised-but-empty transfer hook with a live authority. A non-null program id means unknown code now runs inside every transfer of the collateral.',
  [RefusalCode.SourcesDisagree]:
    'Do not pick the one you like. Two independent sources disagreeing beyond the bound is the only signal either of them is wrong, and choosing between them discards it. Wait for them to converge.',
  [RefusalCode.SingleSource]:
    'Treat the security as unpriced. One number that nothing can contradict is not a price. The fix is registration-side: bind a second, independent source.',
});

export type SeriesRecommendation = 'hold' | 'roll' | 'settle' | 'unpriceable';

export interface SeriesAssessment {
  series: OpenSeries;
  daysToExpiry: number;
  /** What the same strike and expiry quote now, shares per contract, at the live spot. */
  remainingQuoteShares: number | null;
  remainingYield: PremiumYield | null;
  recommendation: SeriesRecommendation;
  line: string;
}

export interface CandidateLine {
  rung: Rung;
  verdict: 'clears' | 'below-hurdle';
  chosen: boolean;
  /** True when the gate refused: priced for the report, not acted on. */
  blocked: boolean;
  line: string;
}

export type ProposalRequest =
  | { kind: 'create_series'; rung: Rung }
  | { kind: 'write'; rung: Rung; contracts: number };

export type WheelDecision =
  | { kind: 'refuse'; refusal: RefusalInfo; guidance: string; line: string }
  | { kind: 'hold'; line: string }
  | { kind: 'write'; rung: Rung; contracts: number; line: string }
  | { kind: 'roll'; from: SeriesAssessment; to: Rung; contracts: number; line: string };

export interface WheelInput {
  underlying: Underlying;
  /** The gate, as `checkActionable` returned it. */
  verdict: GateVerdict;
  now: number;
  /** USD per adjusted share, multiplier applied. Null when the oracle could not be read. */
  spotUsd: number | null;
  openSeries: readonly OpenSeries[];
  /** Contracts the writer has free collateral for. */
  freeContracts: number;
  parameters?: Partial<WheelParameters>;
}

export interface WheelPlan {
  underlying: Underlying;
  now: number;
  spotUsd: number | null;
  parameters: WheelParameters;
  actionable: boolean;
  refusal: RefusalInfo | null;
  open: SeriesAssessment[];
  candidates: CandidateLine[];
  decision: WheelDecision;
  /** Invariant, asserted by the test suite: empty whenever `refusal` is not null. */
  proposals: ProposalRequest[];
  notes: string[];
}

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const sh = (x: number) => x.toFixed(8);
const days = (a: number, b: number) => (b - a) / 86_400;

function candidateLine(rung: Rung, blocked: boolean, chosen: boolean): string {
  const clears =
    rung.hurdleVol === null
      ? 'no volatility reaches the hurdle'
      : `hurdle needs ${pct(rung.hurdleVol)} vol, parameter is ${pct(rung.volAnnual)}`;
  const tail = blocked
    ? 'not acted on: the gate refused'
    : chosen
      ? 'chosen'
      : rung.clearsHurdle
        ? 'clears, not the best rung'
        : 'below the hurdle';
  return (
    `${rung.symbol.padEnd(18)} ${rung.days.toFixed(0).padStart(3)}d  K/S ${rung.moneyness.toFixed(3)}  ` +
    `quote ${sh(rung.quoteSharesPerContract)} sh/ct ($${rung.quoteUsd.toFixed(4)})  ` +
    `${pct(rung.premiumYield.simple).padStart(7)} annualised  |  ${clears}  ->  ${tail}`
  );
}

function assessSeries(
  series: OpenSeries,
  input: WheelInput,
  parameters: WheelParameters,
  bestClearing: Rung | undefined,
): SeriesAssessment {
  const left = days(input.now, series.expiryTs);

  if (left <= 0) {
    return {
      series,
      daysToExpiry: left,
      remainingQuoteShares: null,
      remainingYield: null,
      recommendation: 'settle',
      line: `${series.symbol}: expired ${Math.abs(left).toFixed(1)}d ago. Settlement is the program's job, not the wheel's; the collateral is released by settle_expired.`,
    };
  }

  // Re-price the same strike and expiry at the live spot. This is the series' remaining
  // extrinsic value under the same vol parameter, which is what a roll gives up.
  let remainingQuoteShares: number | null = null;
  let remainingYield: PremiumYield | null = null;
  if (input.spotUsd !== null && series.strike !== null && series.strikeUnits === 'USD per share') {
    try {
      const repriced = quoteRung({
        underlyingTicker: input.underlying.ticker,
        spotUsd: input.spotUsd,
        strikeUsd: series.strike,
        expiryTs: series.expiryTs,
        now: input.now,
        contractSize: series.contractSize ?? parameters.contractSize,
        volAnnual: series.volAnnual ?? input.underlying.volAnnual,
        contracts: parameters.contracts,
        riskFreeRate: parameters.riskFreeRate,
        inventoryVolPremium: parameters.inventoryVolPremium,
        hurdleAnnualised: parameters.hurdleAnnualised,
      });
      remainingQuoteShares = repriced.quoteSharesPerContract;
      remainingYield = annualise(
        repriced.quoteSharesPerContract,
        series.contractSize ?? parameters.contractSize,
        repriced.years,
      );
    } catch {
      remainingQuoteShares = null;
    }
  }

  if (remainingYield === null) {
    return {
      series,
      daysToExpiry: left,
      remainingQuoteShares,
      remainingYield,
      recommendation: 'unpriceable',
      line: `${series.symbol}: ${left.toFixed(1)}d left, cannot be re-priced here (${series.strike === null ? 'no strike recorded' : `quoted in ${series.strikeUnits}`}). Held.`,
    };
  }

  if (left <= parameters.rollWithinDays) {
    const to = bestClearing
      ? `roll into ${bestClearing.symbol} at ${pct(bestClearing.premiumYield.simple)}`
      : 'no replacement rung clears the hurdle, so hold to expiry';
    return {
      series,
      daysToExpiry: left,
      remainingQuoteShares,
      remainingYield,
      recommendation: bestClearing ? 'roll' : 'hold',
      line: `${series.symbol}: ${left.toFixed(1)}d left, inside the ${parameters.rollWithinDays}d roll window; ${sh(remainingQuoteShares ?? 0)} sh/ct of extrinsic value remains (${pct(remainingYield.simple)} annualised). ${to}.`,
    };
  }

  if (remainingYield.simple < parameters.hurdleAnnualised && bestClearing) {
    return {
      series,
      daysToExpiry: left,
      remainingQuoteShares,
      remainingYield,
      recommendation: 'roll',
      line: `${series.symbol}: ${left.toFixed(1)}d left but only ${pct(remainingYield.simple)} annualised remains, under the ${pct(parameters.hurdleAnnualised)} hurdle, while ${bestClearing.symbol} quotes ${pct(bestClearing.premiumYield.simple)}. Roll.`,
    };
  }

  return {
    series,
    daysToExpiry: left,
    remainingQuoteShares,
    remainingYield,
    recommendation: 'hold',
    line: `${series.symbol}: ${left.toFixed(1)}d left, ${pct(remainingYield.simple)} annualised still running against a ${pct(parameters.hurdleAnnualised)} hurdle. Hold.`,
  };
}

export function planWheel(input: WheelInput): WheelPlan {
  const parameters: WheelParameters = { ...DEFAULT_WHEEL, ...input.parameters };
  const notes: string[] = [];
  const blocked = !input.verdict.actionable;
  const refusal: RefusalInfo | null = input.verdict.actionable ? null : REFUSALS[input.verdict.code];

  // Pricing is a read, so the ladder is still quoted when the gate refuses: an operator
  // wants to know what they are not being allowed to do. Acting on it is a different
  // thing, and `proposals` stays empty.
  let ladder: Rung[] = [];
  if (input.spotUsd === null) {
    notes.push('No usable price: the ladder cannot be quoted. Every rung is priced from moneyness, and moneyness needs a spot.');
  } else {
    ladder = buildLadder({
      underlyingTicker: input.underlying.ticker,
      spotUsd: input.spotUsd,
      now: input.now,
      contractSize: parameters.contractSize,
      volAnnual: input.underlying.volAnnual,
      contracts: parameters.contracts,
      riskFreeRate: parameters.riskFreeRate,
      inventoryVolPremium: parameters.inventoryVolPremium,
      hurdleAnnualised: parameters.hurdleAnnualised,
      moneyness: parameters.moneyness,
      tenorDays: parameters.tenorDays,
    });
  }

  const bestClearing = ladder.find((r) => r.clearsHurdle);
  const open = input.openSeries.map((s) => assessSeries(s, input, parameters, bestClearing));
  const candidates: CandidateLine[] = ladder.map((rung) => ({
    rung,
    verdict: rung.clearsHurdle ? ('clears' as const) : ('below-hurdle' as const),
    chosen: false,
    blocked,
    line: candidateLine(rung, blocked, false),
  }));

  if (refusal) {
    return {
      underlying: input.underlying,
      now: input.now,
      spotUsd: input.spotUsd,
      parameters,
      actionable: false,
      refusal,
      open,
      candidates,
      decision: {
        kind: 'refuse',
        refusal,
        guidance: REFUSAL_GUIDANCE[refusal.code],
        line: `refused ${refusal.code} ${refusal.name} (Anchor error ${refusal.errorCode}): ${refusal.message}. Nothing is proposed.`,
      },
      proposals: [],
      notes,
    };
  }

  const rolling = open.find((s) => s.recommendation === 'roll');
  const chosen = bestClearing;
  const mark = (rung: Rung | undefined) => {
    if (!rung) return;
    const entry = candidates.find((c) => c.rung.symbol === rung.symbol);
    if (entry) {
      entry.chosen = true;
      entry.line = candidateLine(rung, false, true);
    }
  };

  if (rolling && chosen) {
    mark(chosen);
    // Collateral for the new leg comes from the old one, and the old one only releases
    // it at settle_expired. So a roll opens the series unconditionally and writes into
    // it only against collateral that is free *now*; if none is, the write waits and the
    // report says what it is waiting for rather than proposing an uncollateralised size.
    const size = Math.min(parameters.contracts, Math.floor(input.freeContracts));
    const proposals: ProposalRequest[] = [{ kind: 'create_series', rung: chosen }];
    if (size >= 1) proposals.push({ kind: 'write', rung: chosen, contracts: size });
    else {
      notes.push(
        `The write leg of this roll is not proposed: free collateral is ${input.freeContracts.toFixed(4)} contracts. ` +
          `It is released when ${rolling.series.symbol} settles (settle_expired), and the wheel will not size a write against collateral it cannot see.`,
      );
    }
    return {
      underlying: input.underlying,
      now: input.now,
      spotUsd: input.spotUsd,
      parameters,
      actionable: true,
      refusal: null,
      open,
      candidates,
      decision: {
        kind: 'roll',
        from: rolling,
        to: chosen,
        contracts: size,
        line:
          `roll ${rolling.series.symbol} into ${chosen.symbol}: ${pct(chosen.premiumYield.simple)} annualised against ` +
          `${pct(rolling.remainingYield?.simple ?? 0)} remaining` +
          (size >= 1 ? `, ${size} contracts.` : ', series opened now and written once the old leg settles.'),
      },
      proposals,
      notes,
    };
  }

  if (chosen && input.freeContracts >= 1) {
    mark(chosen);
    const size = Math.min(parameters.contracts, Math.floor(input.freeContracts));
    return {
      underlying: input.underlying,
      now: input.now,
      spotUsd: input.spotUsd,
      parameters,
      actionable: true,
      refusal: null,
      open,
      candidates,
      decision: {
        kind: 'write',
        rung: chosen,
        contracts: size,
        line: `write ${chosen.symbol}: ${sh(chosen.quoteSharesPerContract)} shares per contract, ${pct(chosen.premiumYield.simple)} annualised, ${size} contracts against free collateral.`,
      },
      proposals: [
        { kind: 'create_series', rung: chosen },
        { kind: 'write', rung: chosen, contracts: size },
      ],
      notes,
    };
  }

  const why = !chosen
    ? ladder.length === 0
      ? 'no rung could be quoted'
      : `no rung clears the ${pct(parameters.hurdleAnnualised)} hurdle at a ${pct(input.underlying.volAnnual)} vol parameter; the best is ${ladder[0]?.symbol} at ${pct(ladder[0]?.premiumYield.simple ?? 0)}`
    : `free collateral is ${input.freeContracts.toFixed(4)} contracts, below one contract`;

  return {
    underlying: input.underlying,
    now: input.now,
    spotUsd: input.spotUsd,
    parameters,
    actionable: true,
    refusal: null,
    open,
    candidates,
    decision: { kind: 'hold', line: `hold: ${why}.` },
    proposals: [],
    notes,
  };
}
