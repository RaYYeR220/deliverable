/**
 * quote.ts — read a live series pool and quote it through `swap2`.
 *
 *   pnpm run quote --series=AAPL261016C352                    read the devnet pool
 *   pnpm run quote --pool=<pubkey> --contracts=5              quote 5 contracts
 *   pnpm run quote --series=... --buy --execute               actually buy (devnet)
 *   pnpm run quote --mainnet --yes --pool=<pubkey>            read-only on mainnet
 *
 * Everything is denominated in the quote asset, which is the tokenised share.
 * A "price" printed here is shares per contract. `swap2` is used rather than the
 * original `swap`: it is the current instruction and it is the only one that
 * supports exact-out, which is what a buyer of N contracts actually wants.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import BN from "bn.js";
import { Decimal } from "decimal.js";
import { PublicKey, sendAndConfirmTransaction, type Connection } from "@solana/web3.js";
import {
  DynamicBondingCurveClient,
  SwapMode,
  getCurrentPoint,
  getPriceFromSqrtPrice,
  type PoolConfig,
  type SwapQuote2Result,
  type VirtualPool,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { connect, isEntrypoint, loadKeypair, parseArgs, resolveCluster, rpcHost, type Cluster } from "./env.ts";
import { BASE_DECIMALS, QUOTE_DECIMALS } from "./curve.ts";
import { ARTIFACT_DIR, type SeriesArtifact } from "./config.ts";

export function loadArtifact(cluster: Cluster, series: string): SeriesArtifact {
  const path = join(ARTIFACT_DIR, `${cluster}-${series}.json`);
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SeriesArtifact;
  } catch {
    throw new Error(`No artifact at ${path}. Create the series first: pnpm run series --execute`);
  }
}

const ui = (raw: BN, decimals: number): string =>
  new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).toFixed(decimals);

const toRaw = (amount: number, decimals: number): BN =>
  new BN(new Decimal(amount).mul(new Decimal(10).pow(decimals)).toFixed(0));

export interface SeriesQuote {
  /** Contracts that change hands. */
  contracts: Decimal;
  /** Shares of the underlying that change hands, fee included. */
  shares: Decimal;
  /** Effective premium, shares per contract. */
  premiumSharesPerContract: Decimal;
  /** Trading fee, in the quote asset (shares) when collectFeeMode is QuoteToken. */
  feeShares: Decimal;
  /** Marginal price after the trade, shares per contract. */
  priceAfter: Decimal;
  raw: SwapQuote2Result;
}

function summarise(result: SwapQuote2Result, contractsRaw: BN, sharesRaw: BN): SeriesQuote {
  const contracts = new Decimal(contractsRaw.toString()).div(new Decimal(10).pow(BASE_DECIMALS));
  const shares = new Decimal(sharesRaw.toString()).div(new Decimal(10).pow(QUOTE_DECIMALS));
  return {
    contracts,
    shares,
    premiumSharesPerContract: contracts.isZero() ? new Decimal(0) : shares.div(contracts),
    feeShares: new Decimal(result.tradingFee.toString()).div(new Decimal(10).pow(QUOTE_DECIMALS)),
    priceAfter: getPriceFromSqrtPrice(result.nextSqrtPrice, BASE_DECIMALS, QUOTE_DECIMALS),
    raw: result,
  };
}

/** Exact-out buy: "give me N contracts, tell me the shares". */
export function quoteBuyExactContracts(
  client: DynamicBondingCurveClient,
  virtualPool: VirtualPool,
  config: PoolConfig,
  contracts: number,
  currentPoint: BN,
  slippageBps: number,
): SeriesQuote {
  const amountOut = toRaw(contracts, BASE_DECIMALS);
  const result = client.pool.swapQuote2({
    virtualPool,
    config,
    swapBaseForQuote: false,
    swapMode: SwapMode.ExactOut,
    amountOut,
    slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  });
  return summarise(result, amountOut, result.includedFeeInputAmount);
}

/** Exact-in sell: "here are N contracts, tell me the shares back". */
export function quoteSellExactContracts(
  client: DynamicBondingCurveClient,
  virtualPool: VirtualPool,
  config: PoolConfig,
  contracts: number,
  currentPoint: BN,
  slippageBps: number,
): SeriesQuote {
  const amountIn = toRaw(contracts, BASE_DECIMALS);
  const result = client.pool.swapQuote2({
    virtualPool,
    config,
    swapBaseForQuote: true,
    swapMode: SwapMode.ExactIn,
    amountIn,
    slippageBps,
    hasReferral: false,
    eligibleForFirstSwapWithMinFee: false,
    currentPoint,
  });
  return summarise(result, amountIn, result.outputAmount);
}

export async function readPool(
  connection: Connection,
  pool: PublicKey,
): Promise<{ client: DynamicBondingCurveClient; virtualPool: VirtualPool; config: PoolConfig; currentPoint: BN }> {
  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const virtualPool = await client.state.getPool(pool);
  if (!virtualPool) throw new Error(`Virtual pool ${pool.toBase58()} not found`);
  const config = await client.state.getPoolConfig(virtualPool.poolState.config);
  if (!config) throw new Error(`PoolConfig ${virtualPool.poolState.config.toBase58()} not found`);
  const currentPoint = await getCurrentPoint(connection, config.activationType);
  return { client, virtualPool, config, currentPoint };
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cluster = resolveCluster(args);
  const connection = connect(cluster);

  const poolArg = args.str("pool");
  const seriesArg = args.str("series");
  let pool: PublicKey;
  let quoteSymbol = "quote";
  if (poolArg) {
    pool = new PublicKey(poolArg);
  } else if (seriesArg) {
    const artifact = loadArtifact(cluster, seriesArg);
    pool = new PublicKey(artifact.accounts.pool);
    quoteSymbol = (artifact.series as Record<string, string>)["quoteSymbol"] ?? "quote";
  } else {
    throw new Error("pass --series=<SYMBOL> or --pool=<pubkey>");
  }

  const contracts = args.num("contracts", 5) as number;
  const slippageBps = args.num("slippage-bps", 100) as number;

  console.log(`cluster          ${cluster}  via ${rpcHost(cluster)}`);
  const { client, virtualPool, config, currentPoint } = await readPool(connection, pool);

  const spot = getPriceFromSqrtPrice(virtualPool.poolState.sqrtPrice, BASE_DECIMALS, QUOTE_DECIMALS);
  console.log(`pool             ${pool.toBase58()}`);
  console.log(`config           ${virtualPool.poolState.config.toBase58()}`);
  console.log(`series mint      ${virtualPool.poolState.baseMint.toBase58()}`);
  console.log(`quote mint       ${config.quoteMint.toBase58()}  (${quoteSymbol})`);
  console.log(`base reserve     ${ui(virtualPool.poolState.baseReserve, BASE_DECIMALS)} contracts`);
  console.log(`quote reserve    ${ui(virtualPool.poolState.quoteReserve, QUOTE_DECIMALS)} shares`);
  console.log(`migration at     ${ui(config.migrationQuoteThreshold, QUOTE_DECIMALS)} shares`);
  console.log(`marginal price   ${spot.toFixed(10)} shares per contract`);
  console.log(`is migrated      ${virtualPool.poolState.isMigrated !== 0}`);
  console.log("");

  const buy = quoteBuyExactContracts(client, virtualPool, config, contracts, currentPoint, slippageBps);
  console.log(`BUY  ${contracts} contracts  (swap2, ExactOut, quote -> base)`);
  console.log(`  pay                ${buy.shares.toFixed(8)} ${quoteSymbol} shares`);
  console.log(`  premium            ${buy.premiumSharesPerContract.toFixed(10)} shares per contract`);
  console.log(`  trading fee        ${buy.feeShares.toFixed(8)} shares`);
  console.log(`  max in (slippage)  ${buy.raw.maximumAmountIn ? ui(buy.raw.maximumAmountIn, QUOTE_DECIMALS) : "n/a"} shares`);
  console.log(`  price after        ${buy.priceAfter.toFixed(10)} shares per contract`);
  console.log("");

  console.log(`SELL ${contracts} contracts  (swap2, ExactIn, base -> quote)`);
  try {
    const sell = quoteSellExactContracts(client, virtualPool, config, contracts, currentPoint, slippageBps);
    console.log(`  receive            ${sell.shares.toFixed(8)} ${quoteSymbol} shares`);
    console.log(`  premium            ${sell.premiumSharesPerContract.toFixed(10)} shares per contract`);
    console.log(`  trading fee        ${sell.feeShares.toFixed(8)} shares`);
    console.log(`  min out (slippage) ${sell.raw.minimumAmountOut ? ui(sell.raw.minimumAmountOut, QUOTE_DECIMALS) : "n/a"} shares`);
    console.log(`  price after        ${sell.priceAfter.toFixed(10)} shares per contract`);
  } catch (error) {
    // A DBC pool holds no quote until someone buys, so a sell larger than the
    // shares already taken in has nothing to pay out with. That is the correct
    // answer for a one-sided curve, not a failure of the quote path.
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  unavailable        ${message}`);
    console.log(`  reason             the pool holds ${ui(virtualPool.poolState.quoteReserve, QUOTE_DECIMALS)} shares; a sell can only be paid out of premium already collected`);
  }

  if (!args.has("execute")) return;
  if (!args.has("buy")) throw new Error("--execute currently only supports --buy");

  const wallet = loadKeypair(args.str("keypair"));
  const tx = await client.pool.swap2({
    owner: wallet.publicKey,
    pool,
    swapBaseForQuote: false,
    swapMode: SwapMode.ExactOut,
    amountOut: toRaw(contracts, BASE_DECIMALS),
    maximumAmountIn: buy.raw.maximumAmountIn ?? buy.raw.includedFeeInputAmount,
    referralTokenAccount: null,
  });

  console.log("");
  console.log("sending swap2 ...");
  const before = await connection.getBalance(wallet.publicKey);
  const signature = await sendAndConfirmTransaction(connection, tx, [wallet], { commitment: "confirmed" });
  const after = await connection.getBalance(wallet.publicKey);
  console.log(`  ${signature}`);
  console.log(`  cost ${before - after} lamports (${((before - after) / 1e9).toFixed(9)} SOL)`);

  const post = await readPool(connection, pool);
  console.log(
    `  pool now: ${ui(post.virtualPool.poolState.quoteReserve, QUOTE_DECIMALS)} shares in, ` +
      `marginal price ${getPriceFromSqrtPrice(post.virtualPool.poolState.sqrtPrice, BASE_DECIMALS, QUOTE_DECIMALS).toFixed(10)} shares per contract`,
  );
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
