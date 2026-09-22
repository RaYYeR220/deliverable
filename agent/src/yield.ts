/**
 * Pricing the rungs the wheel may write, and turning a curve quote into a yield.
 *
 * The Black-Scholes side is imported, never re-implemented: `callPriceInShares` and
 * `buildSeriesCurve` come from `market/src/curve.ts`, the same functions that produce
 * the `ConfigParameters` a Meteora DBC pool is opened with. If the venue's opening
 * quote and the agent's opinion of it ever disagreed, one of them would be lying; they
 * cannot, because they are the same call.
 *
 * The quote the agent reports is the price the curve actually stores on chain
 * (`config.sqrtStartPrice`), not the raw model number. Base and quote decimals are both
 * 8 for an option series (see market/README, "Decimals"), which is the identity case for
 * DBC's price scaling, so price = (sqrtPrice / 2^64)^2 with no decimal correction.
 */
import {
  DEFAULT_CURVE_OPTIONS,
  SECONDS_PER_YEAR,
  buildSeriesCurve,
  callPriceInShares,
  seriesName,
  seriesSymbol,
  type SeriesSpec,
} from '@stocklana/market/src/curve.ts';
import { resolveSession, US_EQUITY_CALENDAR, type CalendarLike } from '@stocklana/sdk';

/** Premium received on the collateral, annualised two ways. */
export interface PremiumYield {
  /** premium / years. The number a desk quotes. */
  simple: number;
  /** ln(1 + premium) / years. The same trade compounded. */
  continuous: number;
}

/**
 * A covered call is written against `contractSize` shares and pays `premiumShares`
 * shares, so the yield on collateral is `premiumShares / contractSize` and the
 * contract size cancels. The premium is denominated in the collateral itself, which
 * is the only reason this is a yield at all rather than a currency conversion.
 */
export function annualise(premiumShares: number, contractSize: number, years: number): PremiumYield {
  if (years <= 0) throw new Error('years must be positive to annualise');
  const perShare = premiumShares / contractSize;
  return { simple: perShare / years, continuous: Math.log1p(perShare) / years };
}

/**
 * The volatility at which the Black-Scholes quote would exactly clear `targetAnnualised`.
 *
 * Vega is strictly positive, so the premium is strictly increasing in vol and a
 * bisection is exact to machine precision. Returns null when no volatility reaches the
 * target: either the target implies a premium above the no-arbitrage cap of one share,
 * or 500% vol still is not enough.
 */
export function hurdleVol(
  targetAnnualised: number,
  moneyness: number,
  years: number,
  riskFreeRate: number,
): number | null {
  const targetPremium = targetAnnualised * years;
  if (!(targetPremium > 0) || targetPremium >= 1) return null;
  const price = (v: number) => callPriceInShares(moneyness, years, v, riskFreeRate);

  let lo = 1e-6;
  let hi = 5;
  if (price(hi) < targetPremium) return null;
  if (price(lo) >= targetPremium) return lo;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (price(mid) < targetPremium) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface RungInput {
  underlyingTicker: string;
  spotUsd: number;
  strikeUsd: number;
  expiryTs: number;
  now: number;
  contractSize: number;
  volAnnual: number;
  contracts: number;
  riskFreeRate: number;
  inventoryVolPremium: number;
  /** Annualised premium yield a rung must clear before the wheel will write it. */
  hurdleAnnualised: number;
}

export interface Rung {
  symbol: string;
  name: string;
  strikeUsd: number;
  moneyness: number;
  expiryTs: number;
  days: number;
  years: number;
  volAnnual: number;
  contractSize: number;
  contracts: number;
  /** What the DBC curve will quote at zero inventory, shares per contract. */
  quoteSharesPerContract: number;
  /** The same premium marked to USD at the live spot. Informational. */
  quoteUsd: number;
  /** Where the top of the inventory ladder sits, shares per contract. */
  topOfLadderShares: number;
  /** A call is never worth more than the share it is written on. */
  noArbitrageCapShares: number;
  premiumYield: PremiumYield;
  /** Vol at which this rung's quote would exactly clear the hurdle. */
  hurdleVol: number | null;
  /** volAnnual >= hurdleVol: the parameter the operator typed clears their own hurdle. */
  clearsHurdle: boolean;
  /** Shares the curve must take in before the series is fully written and graduates. */
  fullyWrittenShares: number;
  spec: SeriesSpec;
}

/** DBC stores a Q64.64 square root. Equal base and quote decimals make this exact. */
function priceFromSqrtQ64(sqrtPrice: bigint): number {
  return (Number(sqrtPrice) / 2 ** 64) ** 2;
}

export function quoteRung(input: RungInput): Rung {
  const spec: SeriesSpec = {
    underlying: input.underlyingTicker,
    spot: input.spotUsd,
    strike: input.strikeUsd,
    expiryTs: input.expiryTs,
    now: input.now,
    contractSize: input.contractSize,
    volAnnual: input.volAnnual,
  };

  const curve = buildSeriesCurve(spec, {
    contracts: input.contracts,
    riskFreeRate: input.riskFreeRate,
    inventoryVolPremium: input.inventoryVolPremium,
  });

  const quoteSharesPerContract = priceFromSqrtQ64(BigInt(curve.config.sqrtStartPrice.toString()));
  const top = curve.ladder[curve.ladder.length - 1];
  const years = curve.yearsToExpiry;

  const premiumYield = annualise(quoteSharesPerContract, input.contractSize, years);
  const vol = hurdleVol(input.hurdleAnnualised, curve.moneyness, years, input.riskFreeRate);

  return {
    symbol: seriesSymbol(spec),
    name: seriesName(spec),
    strikeUsd: input.strikeUsd,
    moneyness: curve.moneyness,
    expiryTs: input.expiryTs,
    days: years * 365.25,
    years,
    volAnnual: input.volAnnual,
    contractSize: input.contractSize,
    contracts: input.contracts,
    quoteSharesPerContract,
    quoteUsd: quoteSharesPerContract * input.spotUsd,
    topOfLadderShares: top ? top.priceSharesPerContract : quoteSharesPerContract,
    noArbitrageCapShares: curve.noArbitrageCapShares,
    premiumYield,
    hurdleVol: vol,
    clearsHurdle: vol !== null && input.volAnnual >= vol,
    fullyWrittenShares: curve.checks.migrationQuoteThresholdShares,
    spec,
  };
}

/**
 * `create_series` validates that expiry lands inside a regular session, so a candidate
 * tenor is walked forward in quarter hours until the committed calendar agrees. The
 * calendar is the SDK's port of the one the program holds, not a second opinion.
 */
export function snapToSession(target: number, calendar: CalendarLike = US_EQUITY_CALENDAR): number | null {
  const step = 15 * 60;
  const limit = (16 * 24 * 60 * 60) / step;
  let at = Math.floor(target / step) * step;
  for (let i = 0; i < limit; i++) {
    if (resolveSession(calendar, at) === 'Regular') return at;
    at += step;
  }
  return null;
}

/** Strikes are quoted on a human tick, not to eight decimal places. */
export function roundStrike(usd: number): number {
  if (usd >= 100) return Math.round(usd);
  if (usd >= 10) return Math.round(usd * 2) / 2;
  return Math.round(usd * 10) / 10;
}

export interface LadderInput extends Omit<RungInput, 'strikeUsd' | 'expiryTs'> {
  moneyness: readonly number[];
  tenorDays: readonly number[];
  calendar?: CalendarLike;
}

/** Every (moneyness, tenor) pair the wheel is willing to consider, priced. */
export function buildLadder(input: LadderInput): Rung[] {
  const rungs: Rung[] = [];
  for (const days of input.tenorDays) {
    const expiryTs = snapToSession(input.now + days * 86_400, input.calendar);
    if (expiryTs === null) continue;
    for (const m of input.moneyness) {
      const strikeUsd = roundStrike(input.spotUsd * m);
      try {
        rungs.push(quoteRung({ ...input, strikeUsd, expiryTs }));
      } catch {
        // buildSeriesCurve refuses a rung it cannot represent — too far out of the money
        // to quote, or a ladder too fine for Q64. A rung that cannot be built is not a
        // rung the wheel may write, so it is dropped rather than approximated.
      }
    }
  }
  return rungs.sort((a, b) => b.premiumYield.simple - a.premiumYield.simple);
}

export { SECONDS_PER_YEAR, DEFAULT_CURVE_OPTIONS };
