/**
 * verify.ts — read a created series back off chain and assert it is what was asked for.
 *
 *   pnpm run verify --series=AAPL261016C352
 *   pnpm run verify --mainnet --yes --series=AAPL261016C352
 *   pnpm run verify --config=<pubkey> --pool=<pubkey>      (no artifact needed)
 *
 * This is the part that matters. Building a config is easy; proving the bytes on
 * chain encode the option you priced is the deliverable. Every assertion below
 * compares a field of the live `PoolConfig` / `VirtualPool` against the request,
 * and the curve is additionally re-priced from the stored sqrt prices so the
 * numbers a trader will see are checked, not just the raw integers.
 */

import BN from "bn.js";
import { Decimal } from "decimal.js";
import { PublicKey, type Connection } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getMint } from "@solana/spl-token";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  deriveTokenBadgeAddress,
  getPriceFromSqrtPrice,
  getTokenProgram,
  type PoolConfig,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connect, isEntrypoint, parseArgs, resolveCluster, rpcHost, type Cluster } from "./env.ts";
import { BASE_DECIMALS, QUOTE_DECIMALS } from "./curve.ts";
import type { SeriesArtifact } from "./config.ts";
import { loadArtifact } from "./quote.ts";

interface Check {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
}

class Checker {
  readonly checks: Check[] = [];

  eq(name: string, expected: unknown, actual: unknown): void {
    const e = stringify(expected);
    const a = stringify(actual);
    this.checks.push({ name, ok: e === a, expected: e, actual: a });
  }

  assert(name: string, ok: boolean, detail: string): void {
    this.checks.push({ name, ok, expected: "true", actual: ok ? "true" : detail });
  }

  get failures(): Check[] {
    return this.checks.filter((c) => !c.ok);
  }

  print(): void {
    const width = Math.max(...this.checks.map((c) => c.name.length));
    for (const c of this.checks) {
      const mark = c.ok ? "ok  " : "FAIL";
      const detail = c.ok ? c.actual : `expected ${c.expected}, got ${c.actual}`;
      console.log(`  ${mark} ${c.name.padEnd(width)}  ${detail}`);
    }
  }
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof BN) return value.toString();
  if (value instanceof PublicKey) return value.toBase58();
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/** The requested ConfigParameters as stored in the artifact, all values as strings. */
type RequestedConfig = Record<string, unknown>;

export async function verifySeries(
  connection: Connection,
  cluster: Cluster,
  configKey: PublicKey,
  poolKey: PublicKey | null,
  requested: RequestedConfig | null,
  expectedAccounts: SeriesArtifact["accounts"] | null,
): Promise<Checker> {
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const checker = new Checker();

  const info = await connection.getAccountInfo(configKey);
  if (!info) throw new Error(`PoolConfig ${configKey.toBase58()} does not exist on ${cluster}`);
  checker.eq("config account owner", DYNAMIC_BONDING_CURVE_PROGRAM_ID, info.owner);

  const config: PoolConfig | null = await client.state.getPoolConfig(configKey);
  if (!config) throw new Error(`PoolConfig ${configKey.toBase58()} did not decode as a DBC config`);

  // --- the quote mint is a real tokenised share ---------------------------
  const quoteMintInfo = await connection.getAccountInfo(config.quoteMint);
  if (!quoteMintInfo) throw new Error(`Quote mint ${config.quoteMint.toBase58()} not found`);
  const quoteMint = await getMint(connection, config.quoteMint, "confirmed", quoteMintInfo.owner);
  checker.eq("quote mint program", TOKEN_2022_PROGRAM_ID, quoteMintInfo.owner);
  checker.eq("quote mint decimals", QUOTE_DECIMALS, quoteMint.decimals);
  checker.eq("config.quoteTokenFlag", 1, config.quoteTokenFlag); // 1 = Token-2022
  if (expectedAccounts) checker.eq("quote mint", expectedAccounts.quoteMint, config.quoteMint);

  // --- the token badge that made this quote mint legal --------------------
  const badge = deriveTokenBadgeAddress(config.quoteMint);
  const badgeInfo = await connection.getAccountInfo(badge);
  if (badgeInfo) {
    // Read the mint out of the account rather than through the SDK's decoder,
    // which returns null for this account. TokenBadge is an 8-byte Anchor
    // discriminator followed by the mint it makes eligible.
    const badgeMint = new PublicKey(badgeInfo.data.subarray(8, 40));
    checker.eq("token badge -> quote mint", config.quoteMint, badgeMint);
    checker.assert("token badge owner", badgeInfo.owner.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID), badgeInfo.owner.toBase58());
  } else {
    checker.assert(
      "token badge",
      cluster === "devnet",
      `no badge at ${badge.toBase58()} — mainnet quote mints with PermanentDelegate require one`,
    );
  }

  // --- the requested parameters, field by field ---------------------------
  if (requested) {
    const fees = requested["poolFees"] as Record<string, Record<string, unknown>>;
    const baseFee = fees["baseFee"] as Record<string, unknown>;
    checker.eq("baseFee.cliffFeeNumerator", baseFee["cliffFeeNumerator"], config.poolFees.baseFee.cliffFeeNumerator);
    checker.eq("baseFee.baseFeeMode", baseFee["baseFeeMode"], config.poolFees.baseFee.baseFeeMode);
    checker.eq("baseFee.firstFactor", baseFee["firstFactor"], config.poolFees.baseFee.firstFactor);
    checker.eq("baseFee.secondFactor", baseFee["secondFactor"], config.poolFees.baseFee.secondFactor);
    checker.eq("baseFee.thirdFactor", baseFee["thirdFactor"], config.poolFees.baseFee.thirdFactor);

    checker.eq("collectFeeMode", requested["collectFeeMode"], config.collectFeeMode);
    checker.eq("migrationOption", requested["migrationOption"], config.migrationOption);
    checker.eq("activationType", requested["activationType"], config.activationType);
    checker.eq("tokenType", requested["tokenType"], config.tokenType);
    checker.eq("tokenDecimal", requested["tokenDecimal"], config.tokenDecimal);
    checker.eq("tokenUpdateAuthority", requested["tokenUpdateAuthority"], config.tokenUpdateAuthority);
    checker.eq("migrationFeeOption", requested["migrationFeeOption"], config.migrationFeeOption);
    checker.eq("sqrtStartPrice", requested["sqrtStartPrice"], config.sqrtStartPrice);
    checker.eq("migrationQuoteThreshold", requested["migrationQuoteThreshold"], config.migrationQuoteThreshold);
    checker.eq("partnerLiquidityPercentage", requested["partnerLiquidityPercentage"], config.partnerLiquidityPercentage);
    checker.eq(
      "partnerPermanentLockedLiquidityPct",
      requested["partnerPermanentLockedLiquidityPercentage"],
      config.partnerPermanentLockedLiquidityPercentage,
    );
    checker.eq("creatorLiquidityPercentage", requested["creatorLiquidityPercentage"], config.creatorLiquidityPercentage);
    checker.eq(
      "creatorPermanentLockedLiquidityPct",
      requested["creatorPermanentLockedLiquidityPercentage"],
      config.creatorPermanentLockedLiquidityPercentage,
    );
    checker.eq("creatorTradingFeePercentage", requested["creatorTradingFeePercentage"], config.creatorTradingFeePercentage);
    checker.eq("poolCreationFee", requested["poolCreationFee"], config.poolCreationFee);

    const migrationFee = requested["migrationFee"] as Record<string, unknown>;
    checker.eq("migrationFee.feePercentage", migrationFee["feePercentage"], config.migrationFeePercentage);
    checker.eq("migrationFee.creatorFeePercentage", migrationFee["creatorFeePercentage"], config.creatorMigrationFeePercentage);

    const migratedPoolFee = requested["migratedPoolFee"] as Record<string, unknown>;
    checker.eq("migratedPoolFee.collectFeeMode", migratedPoolFee["collectFeeMode"], config.migratedCollectFeeMode);
    checker.eq("migratedPoolFee.dynamicFee", migratedPoolFee["dynamicFee"], config.migratedDynamicFee);
    checker.eq("migratedPoolFee.poolFeeBps", migratedPoolFee["poolFeeBps"], config.migratedPoolFeeBps);

    const tokenSupply = requested["tokenSupply"] as Record<string, unknown> | null;
    if (tokenSupply) {
      checker.eq("preMigrationTokenSupply", tokenSupply["preMigrationTokenSupply"], config.preMigrationTokenSupply);
      checker.eq("postMigrationTokenSupply", tokenSupply["postMigrationTokenSupply"], config.postMigrationTokenSupply);
      checker.eq("fixedTokenSupplyFlag", 1, config.fixedTokenSupplyFlag);
    }

    // --- the curve itself --------------------------------------------------
    const requestedCurve = requested["curve"] as Array<Record<string, string>>;
    const stored = config.curve.filter((p) => !p.sqrtPrice.isZero());
    checker.eq("curve points stored", requestedCurve.length, stored.length);
    requestedCurve.forEach((point, i) => {
      const onChain = stored[i];
      checker.eq(`curve[${i}].sqrtPrice`, point["sqrtPrice"], onChain?.sqrtPrice ?? null);
      checker.eq(`curve[${i}].liquidity`, point["liquidity"], onChain?.liquidity ?? null);
    });
  }

  // --- the curve is a legal, strictly increasing price ladder --------------
  const stored = config.curve.filter((p) => !p.sqrtPrice.isZero());
  let monotonic = config.sqrtStartPrice.lt(stored[0]?.sqrtPrice ?? new BN(0));
  for (let i = 1; i < stored.length; i++) {
    if ((stored[i] as { sqrtPrice: BN }).sqrtPrice.lte((stored[i - 1] as { sqrtPrice: BN }).sqrtPrice)) monotonic = false;
  }
  checker.assert("curve strictly increasing on chain", monotonic, "curve is not monotone");

  const startPrice = getPriceFromSqrtPrice(config.sqrtStartPrice, config.tokenDecimal, quoteMint.decimals);
  const topPrice = getPriceFromSqrtPrice(
    (stored[stored.length - 1] as { sqrtPrice: BN }).sqrtPrice,
    config.tokenDecimal,
    quoteMint.decimals,
  );
  console.log(`  --  opening premium  ${startPrice.toFixed(10)} shares per contract`);
  console.log(`  --  top of curve     ${topPrice.toFixed(10)} shares per contract`);
  checker.assert(
    "top of curve under no-arbitrage cap",
    topPrice.lt(new Decimal(1)),
    `${topPrice.toFixed(10)} shares per contract is at or above one whole share`,
  );

  // --- the pool -----------------------------------------------------------
  if (poolKey) {
    const virtualPool = await client.state.getPool(poolKey);
    if (!virtualPool) throw new Error(`Virtual pool ${poolKey.toBase58()} does not exist on ${cluster}`);
    checker.eq("pool.config", configKey, virtualPool.poolState.config);
    // A pool that has never traded must sit exactly on the Black-Scholes premium.
    // Once it has traded it must only have moved up the ladder, never below it.
    const traded = virtualPool.poolState.hasSwap !== 0;
    if (traded) {
      checker.assert(
        "pool.sqrtPrice >= sqrtStartPrice",
        virtualPool.poolState.sqrtPrice.gte(config.sqrtStartPrice),
        `${virtualPool.poolState.sqrtPrice.toString()} < ${config.sqrtStartPrice.toString()}`,
      );
    } else {
      checker.eq("pool.sqrtPrice == sqrtStartPrice", config.sqrtStartPrice, virtualPool.poolState.sqrtPrice);
    }
    checker.eq("pool.poolType (base token program)", 1, virtualPool.poolState.poolType); // 1 = Token-2022
    checker.eq("pool.isMigrated", 0, virtualPool.poolState.isMigrated);

    const derived = deriveDbcPoolAddress(config.quoteMint, virtualPool.poolState.baseMint, configKey);
    checker.eq("pool address is the canonical PDA", derived, poolKey);

    const baseMint = await getMint(
      connection,
      virtualPool.poolState.baseMint,
      "confirmed",
      getTokenProgram(virtualPool.poolState.poolType),
    );
    checker.eq("series mint decimals", BASE_DECIMALS, baseMint.decimals);
    checker.eq("series mint supply", config.preMigrationTokenSupply, new BN(baseMint.supply.toString()));
    if (expectedAccounts) {
      checker.eq("series mint", expectedAccounts.baseMint, virtualPool.poolState.baseMint);
      checker.eq("creator", expectedAccounts.creator, virtualPool.poolState.creator);
    }

    const contracts = new Decimal(baseMint.supply.toString()).div(new Decimal(10).pow(BASE_DECIMALS));
    console.log(`  --  series supply    ${contracts.toFixed(8)} contracts, minted by DBC at pool creation`);
    if (traded) {
      const marginal = getPriceFromSqrtPrice(virtualPool.poolState.sqrtPrice, config.tokenDecimal, quoteMint.decimals);
      console.log(`  --  marginal now     ${marginal.toFixed(10)} shares per contract (pool has traded)`);
    }
  }

  return checker;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cluster = resolveCluster(args);
  const connection = connect(cluster);

  let configKey: PublicKey;
  let poolKey: PublicKey | null = null;
  let requested: RequestedConfig | null = null;
  let accounts: SeriesArtifact["accounts"] | null = null;

  const series = args.str("series");
  if (series) {
    const artifact = loadArtifact(cluster, series);
    configKey = new PublicKey(artifact.accounts.config);
    poolKey = new PublicKey(artifact.accounts.pool);
    requested = artifact.requestedConfig as RequestedConfig;
    accounts = artifact.accounts;
    console.log(`series           ${series}`);
    console.log(`created          ${artifact.createdAt}`);
    for (const [k, v] of Object.entries(artifact.signatures)) console.log(`signature        ${k}: ${v}`);
  } else {
    const configArg = args.str("config");
    if (!configArg) throw new Error("pass --series=<SYMBOL> or --config=<pubkey> [--pool=<pubkey>]");
    configKey = new PublicKey(configArg);
    const poolArg = args.str("pool");
    if (poolArg) poolKey = new PublicKey(poolArg);
  }

  console.log(`cluster          ${cluster}  via ${rpcHost(cluster)}`);
  console.log(`config           ${configKey.toBase58()}`);
  if (poolKey) console.log(`pool             ${poolKey.toBase58()}`);
  console.log("");

  const checker = await verifySeries(connection, cluster, configKey, poolKey, requested, accounts);
  console.log("");
  checker.print();
  console.log("");

  const failures = checker.failures;
  if (failures.length > 0) {
    console.error(`${failures.length} of ${checker.checks.length} checks FAILED`);
    process.exitCode = 1;
    return;
  }
  console.log(`all ${checker.checks.length} checks passed`);
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
