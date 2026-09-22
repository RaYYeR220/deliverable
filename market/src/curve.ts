/**
 * buildSeriesCurve — turn a covered-call option series into a Meteora Dynamic
 * Bonding Curve configuration.
 *
 * The premise: the DBC pool for an option series is quoted in the *underlying
 * tokenised share*, not in SOL or USDC. That single choice changes what the
 * curve means.
 *
 *   base  token = the option series token (1 token = 1 contract)
 *   quote token = the xStock the contract is written on (Token-2022, 8 decimals)
 *   price       = quote per base = SHARES PER CONTRACT = the premium
 *
 * So the y-axis of the bonding curve is literally the option premium, and the
 * x-axis is cumulative inventory sold. The curve is an option pricing surface
 * sampled in inventory space, not a launch ramp.
 *
 * Three consequences that only exist because the quote asset is the underlying:
 *
 *  1. Spot cancels. Under the share numeraire the Black-Scholes call price is
 *     C/S = N(d1) - (K/S) e^{-rT} N(d2), which depends only on moneyness K/S,
 *     time, vol and rate. The curve is therefore defined in moneyness space and
 *     needs no USD oracle to be struck correctly at inception.
 *  2. There is a hard no-arbitrage ceiling. A call is never worth more than the
 *     share it is written on, so the premium can never exceed `contractSize`
 *     shares per contract. The curve's top price is bounded by that, and the
 *     bound is checked here. A SOL-quoted pool cannot express this constraint.
 *  3. Supply is bounded by collateral, not by taste. The series token is fully
 *     covered, so total supply is exactly the number of contracts the writer's
 *     vault has shares for — DBC's fixed-supply mode is a requirement here.
 *
 * HONESTY NOTE, and it belongs in the code rather than only the README:
 * `volAnnual` is an INPUT, a pricing convention chosen by whoever creates the
 * series. It is not a market-calibrated implied-vol surface, there is no skew by
 * strike, and the curve is struck once at t=0 and does not re-mark as spot moves
 * or time passes. What the curve gives you is a defensible, reproducible opening
 * quote and a monotone inventory ladder; price discovery after that is the
 * market's job, and the DAMM v2 pool the series migrates into is where it
 * happens.
 */

import BN from "bn.js";
import { Decimal } from "decimal.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  MAX_CURVE_POINT,
  MAX_SQRT_PRICE,
  MIN_SQRT_PRICE,
  MigrationFeeOption,
  MigrationOption,
  Rounding,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurveWithCustomSqrtPrices,
  getBaseTokenForSwap,
  getCurveBreakdown,
  getDeltaAmountBaseUnsigned,
  getPriceFromSqrtPrice,
  getSqrtPriceFromPrice,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { isEntrypoint, parseArgs } from "./env.ts";

// ---------------------------------------------------------------------------
// Black-Scholes, written out. No dependency, ~30 lines, and it is the only
// place a model assumption enters the curve.
// ---------------------------------------------------------------------------

/**
 * Abramowitz & Stegun 26.2.17 rational approximation of the standard normal CDF.
 * Absolute error < 7.5e-8, which is four orders of magnitude finer than the
 * uncertainty in any volatility number a human will type in.
 */
export function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return 0.5 * (1 + sign * erf);
}

/**
 * European call price expressed in UNITS OF THE UNDERLYING (shares per share).
 *
 * This is the share-numeraire form: C/S = N(d1) - m e^{-rT} N(d2) with m = K/S.
 * Spot never appears, which is exactly why a pool quoted in the underlying can
 * be priced without a USD oracle.
 *
 * Returns a value in [0, 1). The upper bound is the no-arbitrage cap C <= S.
 */
export function callPriceInShares(
  moneyness: number,
  yearsToExpiry: number,
  vol: number,
  riskFreeRate: number,
): number {
  if (!(moneyness > 0)) throw new Error("moneyness must be positive");
  if (yearsToExpiry <= 0) return Math.max(0, 1 - moneyness); // intrinsic, in shares
  if (vol <= 0) return Math.max(0, 1 - moneyness * Math.exp(-riskFreeRate * yearsToExpiry));
  const sqrtT = Math.sqrt(yearsToExpiry);
  const d1 = (-Math.log(moneyness) + (riskFreeRate + 0.5 * vol * vol) * yearsToExpiry) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  return normalCdf(d1) - moneyness * Math.exp(-riskFreeRate * yearsToExpiry) * normalCdf(d2);
}

export const SECONDS_PER_YEAR = 365.25 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface SeriesSpec {
  /** Display ticker of the underlying, e.g. "AAPL". Used for the token symbol. */
  underlying: string;
  /** Reference spot, USD per share. Only used for human-readable output and for
   *  deriving moneyness — it cancels out of the premium itself. */
  spot: number;
  /** Strike, USD per share. */
  strike: number;
  /** Expiry, unix seconds. */
  expiryTs: number;
  /** Valuation time, unix seconds. */
  now: number;
  /** Underlying shares per contract. 1 by default; the US 100-share convention
   *  is expressible but makes every premium 100x larger in share terms. */
  contractSize: number;
  /** Annualised volatility. A PARAMETER, not a calibrated market IV. */
  volAnnual: number;
}

export interface CurveOptions {
  /** Total contracts the writer's vault is collateralising. This is the entire
   *  token supply: the series is fully covered by construction. */
  contracts: number;
  /**
   * Inventory vol premium, lambda. The implied vol used to price the marginal
   * contract rises linearly from `volAnnual` at zero inventory to
   * `volAnnual * (1 + lambda)` when the whole series is sold. This is the
   * standard market-maker inventory markup, expressed in the only variable an
   * option quote actually has.
   */
  inventoryVolPremium: number;
  /** Number of curve segments. DBC caps the stored curve at 16 points. */
  segments: number;
  /** Continuously-compounded risk-free rate. Default 0 — see README. */
  riskFreeRate: number;
  /** Opening base fee, bps. Charged in the quote asset, i.e. in shares. */
  startingFeeBps: number;
  /** Floor base fee, bps. DBC's minimum is 25. */
  endingFeeBps: number;
  /** Fee-scheduler steps between the two over the life of the option. */
  feePeriods: number;
  /** Fraction of supply held back as leftover, returned to the vault so its
   *  collateral is released. Also absorbs DBC's own rounding. */
  leftoverFraction: number;
  /** Share of trading fees routed to the series creator (the writer's vault). */
  creatorTradingFeePercentage: number;
  /** Relative tolerance on |curve start price / theoretical premium - 1|. */
  priceTolerance: number;
}

export const DEFAULT_CURVE_OPTIONS: CurveOptions = {
  contracts: 1000,
  inventoryVolPremium: 0.5,
  segments: 16,
  riskFreeRate: 0,
  startingFeeBps: 200,
  endingFeeBps: 25,
  feePeriods: 60,
  leftoverFraction: 0.01,
  creatorTradingFeePercentage: 80,
  priceTolerance: 1e-9,
};

/**
 * Decimals.
 *
 * QUOTE is fixed at 8 — every xStock is Token-2022 with 8 decimals.
 *
 * BASE is deliberately also 8, not the 6 that almost every existing stock-quoted
 * config on this program uses (23 of 25 sampled AAPLx configs). The reason is settlement, not aesthetics: one contract settles
 * into `contractSize` shares, so with contractSize = 1 the smallest divisible
 * unit of the series token maps exactly onto the smallest divisible unit of the
 * share it exercises into. Choosing 9 would mint dust that can never be
 * exercised (1e-9 of a contract owes 1e-9 of a share, below the xStock's 1e-8
 * granularity); choosing 6 would make the contract 100x coarser than its own
 * collateral for no benefit. 8 is also the identity case for DBC's price scaling
 * (base and quote decimals equal), so a raw sqrt-price maps to shares-per-contract
 * with no decimal correction at all.
 */
export const QUOTE_DECIMALS = TokenDecimal.EIGHT;
export const BASE_DECIMALS = TokenDecimal.EIGHT;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface LadderPoint {
  /** Segment boundary index, 0 = curve start. */
  index: number;
  /** Cumulative contracts sold at this boundary, by construction of the weights. */
  inventoryContracts: number;
  /** Implied vol used to price the marginal contract here. */
  vol: number;
  /** Premium in shares per contract. */
  priceSharesPerContract: number;
  /** Same premium marked back to USD at the reference spot. Informational only. */
  priceUsd: number;
  sqrtPrice: BN;
}

export interface SeriesCurve {
  spec: SeriesSpec;
  options: CurveOptions;
  /** Moneyness K/S. The premium depends on this, not on spot. */
  moneyness: number;
  yearsToExpiry: number;
  /** Theoretical premium at zero inventory, shares per contract. */
  theoreticalPremiumShares: number;
  /** Same, marked to USD at the reference spot. Informational only. */
  theoreticalPremiumUsd: number;
  /** The no-arbitrage ceiling: a covered call is never worth more than its collateral. */
  noArbitrageCapShares: number;
  ladder: LadderPoint[];
  sqrtPrices: BN[];
  liquidityWeights: number[];
  /** The ConfigParameters that go on chain verbatim. */
  config: ConfigParameters;
  checks: CurveChecks;
}

export interface CurveChecks {
  monotonic: boolean;
  /** Relative error of the on-chain start price against the theoretical premium. */
  startPriceRelativeError: number;
  withinTolerance: boolean;
  belowNoArbitrageCap: boolean;
  withinSqrtPriceBounds: boolean;
  curvePoints: number;
  /** Quote (shares) the pool must take in before it graduates to DAMM v2. */
  migrationQuoteThresholdShares: number;
  /** Contracts actually sold along the bonding curve. */
  curveContracts: number;
  /** Contracts DBC holds back to seed the DAMM v2 pool at graduation. */
  migrationContracts: number;
  /** Contracts absorbed by each segment. These should be near-identical: that
   *  is what makes the implied-vol ladder linear in inventory. */
  segmentContracts: number[];
  /** Largest relative deviation between segment inventories. */
  segmentInventorySpread: number;
  /** Average realised premium if the whole curve is bought, shares per contract. */
  averagePremiumShares: number;
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

export function buildSeriesCurve(
  spec: SeriesSpec,
  overrides: Partial<CurveOptions> = {},
): SeriesCurve {
  const options: CurveOptions = { ...DEFAULT_CURVE_OPTIONS, ...overrides };

  if (spec.expiryTs <= spec.now) throw new Error("expiryTs must be in the future relative to now");
  if (spec.contractSize <= 0) throw new Error("contractSize must be positive");
  if (spec.volAnnual <= 0) throw new Error("volAnnual must be positive");
  if (spec.spot <= 0 || spec.strike <= 0) throw new Error("spot and strike must be positive");
  if (options.segments < 1 || options.segments > MAX_CURVE_POINT) {
    throw new Error(`segments must be between 1 and ${MAX_CURVE_POINT} (DBC stores at most that many curve points)`);
  }
  if (options.inventoryVolPremium <= 0) {
    throw new Error("inventoryVolPremium must be positive, otherwise the curve is flat and DBC rejects it");
  }

  const yearsToExpiry = (spec.expiryTs - spec.now) / SECONDS_PER_YEAR;
  const moneyness = spec.strike / spec.spot;

  // Premium per contract, in shares. contractSize scales the per-share price.
  const premiumAt = (vol: number): number =>
    spec.contractSize * callPriceInShares(moneyness, yearsToExpiry, vol, options.riskFreeRate);

  const theoreticalPremiumShares = premiumAt(spec.volAnnual);
  const noArbitrageCapShares = spec.contractSize;

  if (!(theoreticalPremiumShares > 0)) {
    throw new Error(
      "Theoretical premium rounds to zero in share terms. The series is too far out of the money or too short-dated to quote.",
    );
  }

  // --- the ladder: one vol step per segment, priced with Black-Scholes -------
  // Vega is strictly positive, so a strictly increasing vol ladder gives a
  // strictly increasing price ladder. Monotonicity is a theorem here, not a
  // post-hoc sort.
  const ladderVols: number[] = [];
  for (let i = 0; i <= options.segments; i++) {
    ladderVols.push(spec.volAnnual * (1 + (options.inventoryVolPremium * i) / options.segments));
  }
  const prices = ladderVols.map(premiumAt);

  const topPrice = prices[prices.length - 1] as number;
  if (topPrice >= noArbitrageCapShares) {
    throw new Error(
      `Curve top price ${topPrice.toFixed(8)} shares/contract breaches the no-arbitrage cap of ` +
        `${noArbitrageCapShares} (a call cannot be worth more than the share it is written on). ` +
        "Lower inventoryVolPremium or volAnnual.",
    );
  }

  const sqrtPrices = prices.map((p) =>
    getSqrtPriceFromPrice(new Decimal(p).toFixed(20), BASE_DECIMALS, QUOTE_DECIMALS),
  );

  let monotonic = true;
  for (let i = 1; i < sqrtPrices.length; i++) {
    if ((sqrtPrices[i] as BN).lte(sqrtPrices[i - 1] as BN)) monotonic = false;
  }
  if (!monotonic) {
    throw new Error(
      "Curve is not strictly increasing after fixed-point conversion. The vol steps are too fine for Q64 resolution; reduce `segments` or raise `inventoryVolPremium`.",
    );
  }

  const withinSqrtPriceBounds =
    (sqrtPrices[0] as BN).gte(MIN_SQRT_PRICE) && (sqrtPrices[sqrtPrices.length - 1] as BN).lte(MAX_SQRT_PRICE);
  if (!withinSqrtPriceBounds) throw new Error("Curve leaves DBC's representable sqrt-price range");

  // --- liquidity weights: equal inventory per vol step ----------------------
  // DBC segment i holds base = L_i * (1/sqrtP_{i-1} - 1/sqrtP_i). Setting
  // L_i proportional to the reciprocal of that bracket makes every segment
  // absorb the same number of contracts, so the implied vol the pool quotes
  // rises LINEARLY IN INVENTORY SOLD rather than linearly in price.
  const liquidityWeights: number[] = [];
  for (let i = 0; i < options.segments; i++) {
    const lower = new Decimal((sqrtPrices[i] as BN).toString());
    const upper = new Decimal((sqrtPrices[i + 1] as BN).toString());
    const bracket = new Decimal(1).div(lower).sub(new Decimal(1).div(upper));
    liquidityWeights.push(new Decimal(1).div(bracket).toNumber());
  }
  const firstWeight = liquidityWeights[0] as number;
  const normalisedWeights = liquidityWeights.map((w) => w / firstWeight);

  // --- the config ----------------------------------------------------------
  const lifeSeconds = spec.expiryTs - spec.now;
  const feePeriods = Math.max(1, Math.min(options.feePeriods, lifeSeconds));

  const config = buildCurveWithCustomSqrtPrices({
    token: {
      // Token-2022 for the series token so a later revision can hang an exercise
      // gate off the transfer-hook socket without reissuing the series.
      tokenType: TokenType.Token2022,
      tokenBaseDecimal: BASE_DECIMALS,
      tokenQuoteDecimal: QUOTE_DECIMALS,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: options.contracts,
      leftover: Math.max(1, Math.floor(options.contracts * options.leftoverFraction)),
    },
    fee: {
      baseFeeParams: {
        // The fee decays over exactly the option's life. It is a model-risk
        // charge: early in the series the quoted price is almost entirely
        // extrinsic and therefore almost entirely model, while at expiry the
        // series token is a pure intrinsic claim with no model in it at all.
        // The venue takes the most where its own number is least defensible.
        baseFeeMode: BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
          startingFeeBps: options.startingFeeBps,
          endingFeeBps: options.endingFeeBps,
          numberOfPeriod: feePeriods,
          totalDuration: lifeSeconds,
        },
      },
      dynamicFeeEnabled: false,
      // Fees accrue in the quote asset, so the venue is paid in shares too.
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: options.creatorTradingFeePercentage,
      poolCreationFee: 0,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      // 25 bps on the migrated pool: after graduation the series token is a
      // near-linear claim on the underlying, so it deserves a tight spread.
      migrationFeeOption: MigrationFeeOption.FixedBps25,
      migrationFee: { feePercentage: 0, creatorFeePercentage: 0 },
    },
    liquidityDistribution: {
      partnerLiquidityPercentage: 0,
      partnerPermanentLockedLiquidityPercentage: 0,
      // DBC requires at least 10% of migrated liquidity to still be locked one
      // day after migration. Take exactly that and leave the rest claimable by
      // the writer's vault, which needs it back to settle the series at expiry.
      creatorLiquidityPercentage: 90,
      creatorPermanentLockedLiquidityPercentage: 10,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    // Timestamp, so the fee schedule's clock is wall-clock time to expiry rather
    // than a slot count that drifts against it.
    activationType: ActivationType.Timestamp,
    sqrtPrices,
    liquidityWeights: normalisedWeights,
  });

  // --- checks --------------------------------------------------------------
  const onChainStartPrice = getPriceFromSqrtPrice(config.sqrtStartPrice, BASE_DECIMALS, QUOTE_DECIMALS);
  const startPriceRelativeError = onChainStartPrice
    .div(new Decimal(theoreticalPremiumShares))
    .sub(1)
    .abs()
    .toNumber();

  const migrationQuoteThresholdShares =
    new Decimal(config.migrationQuoteThreshold.toString()).div(new Decimal(10).pow(QUOTE_DECIMALS)).toNumber();

  // Exact inventory the curve sells, read back out of the parameters DBC will
  // store rather than assumed from the inputs.
  const baseUnit = new Decimal(10).pow(BASE_DECIMALS);
  const toContracts = (raw: BN): number => new Decimal(raw.toString()).div(baseUnit).toNumber();

  const curveContracts = toContracts(
    getBaseTokenForSwap(config.sqrtStartPrice, sqrtPrices[sqrtPrices.length - 1] as BN, config.curve),
  );
  const totalSwapAndMigration =
    options.contracts - Math.max(1, Math.floor(options.contracts * options.leftoverFraction));
  const migrationContracts = totalSwapAndMigration - curveContracts;

  const segmentContracts: number[] = [];
  const cumulativeContracts: number[] = [0];
  for (let i = 0; i < config.curve.length; i++) {
    const lower = i === 0 ? config.sqrtStartPrice : (config.curve[i - 1] as { sqrtPrice: BN }).sqrtPrice;
    const point = config.curve[i] as { sqrtPrice: BN; liquidity: BN };
    const amount = toContracts(
      getDeltaAmountBaseUnsigned(lower, point.sqrtPrice, point.liquidity, Rounding.Down),
    );
    segmentContracts.push(amount);
    cumulativeContracts.push((cumulativeContracts[i] as number) + amount);
  }
  const minSegment = Math.min(...segmentContracts);
  const maxSegment = Math.max(...segmentContracts);
  const segmentInventorySpread = minSegment > 0 ? maxSegment / minSegment - 1 : Number.POSITIVE_INFINITY;

  const ladder: LadderPoint[] = prices.map((price, i) => ({
    index: i,
    inventoryContracts: cumulativeContracts[i] as number,
    vol: ladderVols[i] as number,
    priceSharesPerContract: price,
    priceUsd: price * spec.spot,
    sqrtPrice: sqrtPrices[i] as BN,
  }));

  const { totalAmount: curveQuoteRaw } = getCurveBreakdown(
    config.migrationQuoteThreshold,
    config.sqrtStartPrice,
    config.curve,
  );
  const curveQuoteShares = new Decimal(curveQuoteRaw.toString())
    .div(new Decimal(10).pow(QUOTE_DECIMALS))
    .toNumber();

  const checks: CurveChecks = {
    monotonic,
    startPriceRelativeError,
    withinTolerance: startPriceRelativeError <= options.priceTolerance,
    belowNoArbitrageCap: topPrice < noArbitrageCapShares,
    withinSqrtPriceBounds,
    curvePoints: config.curve.length,
    migrationQuoteThresholdShares,
    curveContracts,
    migrationContracts,
    segmentContracts,
    segmentInventorySpread,
    averagePremiumShares: curveQuoteShares / Math.max(curveContracts, 1e-12),
  };

  if (!checks.withinTolerance) {
    throw new Error(
      `Curve start price is ${startPriceRelativeError.toExponential(3)} away from the theoretical premium, ` +
        `tolerance is ${options.priceTolerance.toExponential(3)}.`,
    );
  }

  return {
    spec,
    options,
    moneyness,
    yearsToExpiry,
    theoreticalPremiumShares,
    theoreticalPremiumUsd: theoreticalPremiumShares * spec.spot,
    noArbitrageCapShares,
    ladder,
    sqrtPrices,
    liquidityWeights: normalisedWeights,
    config,
    checks,
  };
}

/** Canonical series name, in the OCC-ish shape a desk would recognise. */
export function seriesSymbol(spec: SeriesSpec): string {
  const d = new Date(spec.expiryTs * 1000);
  const yy = String(d.getUTCFullYear() % 100).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const strike = Number.isInteger(spec.strike) ? String(spec.strike) : spec.strike.toFixed(2);
  return `${spec.underlying.toUpperCase()}${yy}${mm}${dd}C${strike}`;
}

export function seriesName(spec: SeriesSpec): string {
  const d = new Date(spec.expiryTs * 1000).toISOString().slice(0, 10);
  return `${spec.underlying.toUpperCase()} ${d} ${spec.strike} Call`;
}

// ---------------------------------------------------------------------------
// CLI: `pnpm run curve --strike=340 --days=30 --vol=0.32`  ·  `pnpm run curve --selftest`
// ---------------------------------------------------------------------------

export function describeCurve(curve: SeriesCurve): string {
  const { spec, options, checks } = curve;
  const lines: string[] = [];
  const f = (n: number, dp = 8) => n.toFixed(dp);

  lines.push(`series           ${seriesName(spec)}  [${seriesSymbol(spec)}]`);
  lines.push(`spot / strike    $${spec.spot} / $${spec.strike}   moneyness K/S = ${f(curve.moneyness, 6)}`);
  lines.push(`time to expiry   ${f(curve.yearsToExpiry * 365.25, 3)} days  (${f(curve.yearsToExpiry, 6)} y)`);
  lines.push(`vol (PARAMETER)  ${f(spec.volAnnual * 100, 2)}%  ->  ${f(spec.volAnnual * (1 + options.inventoryVolPremium) * 100, 2)}% at full inventory`);
  lines.push(`contract size    ${spec.contractSize} share(s) of the underlying`);
  lines.push("");
  lines.push(`premium @ t=0    ${f(curve.theoreticalPremiumShares)} shares/contract   (= $${f(curve.theoreticalPremiumUsd, 4)} at the reference spot)`);
  lines.push(`no-arb ceiling   ${f(curve.noArbitrageCapShares)} shares/contract   (a call <= the share it is written on)`);
  lines.push("");
  lines.push("inventory ladder (each rung is one implied-vol step, equal contracts per rung):");
  lines.push("   #   contracts sold        iv     shares/contract        usd   sqrtPrice (Q64)");
  for (const p of curve.ladder) {
    lines.push(
      `  ${String(p.index).padStart(2)}  ${p.inventoryContracts.toFixed(1).padStart(14)}  ${(p.vol * 100).toFixed(2).padStart(6)}%  ` +
        `${f(p.priceSharesPerContract).padStart(16)}  ${p.priceUsd.toFixed(4).padStart(9)}   ${p.sqrtPrice.toString()}`,
    );
  }
  lines.push("");
  lines.push("checks:");
  lines.push(`  strictly increasing            ${checks.monotonic}`);
  lines.push(`  start price vs Black-Scholes   ${checks.startPriceRelativeError.toExponential(3)} relative (tolerance ${options.priceTolerance.toExponential(3)}) -> ${checks.withinTolerance}`);
  lines.push(`  below no-arbitrage cap         ${checks.belowNoArbitrageCap}`);
  lines.push(`  within DBC sqrt-price bounds   ${checks.withinSqrtPriceBounds}`);
  lines.push(`  curve points stored on chain   ${checks.curvePoints} / ${MAX_CURVE_POINT}`);
  lines.push(`  equal inventory per rung       spread ${(checks.segmentInventorySpread * 100).toFixed(4)}% across ${checks.segmentContracts.length} segments`);
  lines.push("");
  lines.push(`supply           ${options.contracts} contracts, fixed (bounded by the vault's collateral)`);
  lines.push(`  on the curve   ${f(checks.curveContracts, 4)} contracts`);
  lines.push(`  seeds DAMM v2  ${f(checks.migrationContracts, 4)} contracts`);
  lines.push(`graduation       ${f(checks.migrationQuoteThresholdShares, 6)} shares taken in -> migrate to DAMM v2`);
  lines.push(`avg premium      ${f(checks.averagePremiumShares)} shares/contract across the whole curve`);
  return lines.join("\n");
}

/**
 * Self-test for the pricing layer. Two textbook Black-Scholes values and the
 * put-call parity identity, plus the structural invariants the curve relies on.
 * Runs with `pnpm run curve --selftest` and needs no network.
 */
export function selfTest(): { name: string; ok: boolean; detail: string }[] {
  const results: { name: string; ok: boolean; detail: string }[] = [];
  const near = (name: string, actual: number, expected: number, tol: number) =>
    results.push({
      name,
      ok: Math.abs(actual - expected) <= tol,
      detail: `${actual.toPrecision(10)} vs ${expected} (tol ${tol})`,
    });

  // Hull, Options Futures and Other Derivatives: S=42, K=40, r=10%, sigma=20%,
  // T=0.5 gives a call of 4.76. In shares that is 4.759/42.
  near("Hull 42/40/0.5y/20%/10%", callPriceInShares(40 / 42, 0.5, 0.2, 0.1) * 42, 4.759, 5e-3);
  // At-the-money one year, 20% vol, 5% rate: the standard 10.4506 reference.
  near("ATM 100/100/1y/20%/5%", callPriceInShares(1, 1, 0.2, 0.05) * 100, 10.4506, 1e-3);

  // Put-call parity in the share numeraire: C/S - P/S = 1 - m e^{-rT}.
  const m = 1.1;
  const T = 0.25;
  const vol = 0.35;
  const r = 0.03;
  const call = callPriceInShares(m, T, vol, r);
  // P/S from parity, then rebuilt from the same normal CDFs, must agree.
  const sqrtT = Math.sqrt(T);
  const d1 = (-Math.log(m) + (r + 0.5 * vol * vol) * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const put = m * Math.exp(-r * T) * normalCdf(-d2) - normalCdf(-d1);
  near("put-call parity", call - put, 1 - m * Math.exp(-r * T), 1e-9);

  // Vega is positive, which is what makes the inventory ladder monotone.
  const lowVol = callPriceInShares(1.05, 0.08, 0.3, 0);
  const highVol = callPriceInShares(1.05, 0.08, 0.45, 0);
  results.push({ name: "vega > 0", ok: highVol > lowVol, detail: `${lowVol} -> ${highVol}` });

  // No-arbitrage: even at absurd vol the call stays under one share.
  const absurd = callPriceInShares(1, 2, 5, 0);
  results.push({ name: "call < 1 share at 500% vol", ok: absurd < 1, detail: absurd.toPrecision(10) });

  // The full curve builder produces a legal, monotone, on-target config.
  const now = 1_790_000_000;
  const curve = buildSeriesCurve({
    underlying: "AAPL",
    spot: 335,
    strike: 352,
    expiryTs: now + 30 * 86400,
    now,
    contractSize: 1,
    volAnnual: 0.3,
  });
  results.push({ name: "curve monotone", ok: curve.checks.monotonic, detail: "strictly increasing" });
  results.push({
    name: "curve start on premium",
    ok: curve.checks.withinTolerance,
    detail: curve.checks.startPriceRelativeError.toExponential(3),
  });
  results.push({
    name: "equal inventory per rung",
    ok: curve.checks.segmentInventorySpread < 1e-6,
    detail: `${(curve.checks.segmentInventorySpread * 100).toExponential(3)}%`,
  });
  results.push({
    name: "top under no-arbitrage cap",
    ok: curve.checks.belowNoArbitrageCap,
    detail: `${(curve.ladder[curve.ladder.length - 1] as LadderPoint).priceSharesPerContract.toPrecision(8)} < ${curve.noArbitrageCapShares}`,
  });
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.has("selftest")) {
    const results = selfTest();
    const width = Math.max(...results.map((r) => r.name.length));
    for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name.padEnd(width)}  ${r.detail}`);
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed === 0 ? `\nall ${results.length} checks passed` : `\n${failed} checks FAILED`);
    if (failed > 0) process.exitCode = 1;
    return;
  }

  const now = args.num("now", Math.floor(Date.now() / 1000)) as number;
  const days = args.num("days", 30) as number;
  const spot = args.num("spot", 335) as number;

  const spec: SeriesSpec = {
    underlying: args.str("underlying", "AAPL") as string,
    spot,
    strike: args.num("strike", Math.round(spot * 1.05)) as number,
    expiryTs: args.num("expiry", Math.floor(now + days * 86400)) as number,
    now,
    contractSize: args.num("contract-size", 1) as number,
    volAnnual: args.num("vol", 0.3) as number,
  };

  const overrides: Partial<CurveOptions> = {};
  const contracts = args.num("contracts");
  if (contracts !== undefined) overrides.contracts = contracts;
  const lambda = args.num("vol-premium");
  if (lambda !== undefined) overrides.inventoryVolPremium = lambda;
  const segments = args.num("segments");
  if (segments !== undefined) overrides.segments = segments;
  const rate = args.num("rate");
  if (rate !== undefined) overrides.riskFreeRate = rate;

  const curve = buildSeriesCurve(spec, overrides);
  console.log(describeCurve(curve));
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
