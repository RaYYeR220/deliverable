/**
 * config.ts — build the PoolConfig for an option series and open its DBC pool.
 *
 *   pnpm run series --dry-run                      decode and print, send nothing
 *   pnpm run series --execute                      create config + pool on devnet
 *   pnpm run series --mainnet --yes --simulate     simulate the real mainnet tx
 *   pnpm run series --mainnet --yes --execute      spend real SOL (double-gated)
 *
 * One transaction, two instructions:
 *   create_config(ConfigParameters)              -> PoolConfig account
 *   initialize_virtual_pool_with_token2022(...)  -> VirtualPool + series mint
 *
 * Both take the DBC token badge for the quote mint as REMAINING ACCOUNT INDEX 0.
 * xStocks carry a PermanentDelegate extension, which is outside DBC's
 * permissionless Token-2022 allowlist, so without the badge the program returns
 * InvalidTokenBadge. The badge itself is created by a Meteora operator and
 * already exists for 740 xStocks mints, so creating a stock-quoted config is
 * permissionless today. This file passes the badge whenever the PDA exists on
 * chain and says so in its output either way.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveClient,
  DynamicBondingCurveIdl,
  deriveDbcPoolAddress,
  deriveTokenBadgeAddress,
  type ConfigParameters,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  MARKET_DIR,
  connect,
  loadKeypair,
  parseArgs,
  isEntrypoint,
  resolveCluster,
  rpcHost,
  type CliFlags,
  type Cluster,
} from "./env.ts";
import {
  DEFAULT_CURVE_OPTIONS,
  buildSeriesCurve,
  describeCurve,
  seriesName,
  seriesSymbol,
  type CurveOptions,
  type SeriesCurve,
  type SeriesSpec,
} from "./curve.ts";
import { describeConfigParameters, toJson, type Json } from "./format.ts";
import { resolveUnderlying } from "./underlyings.ts";

export const ARTIFACT_DIR = join(MARKET_DIR, "artifacts");

export interface SeriesArtifact {
  cluster: Cluster;
  createdAt: string;
  dbcProgram: string;
  series: Json;
  curveOptions: Json;
  accounts: {
    config: string;
    baseMint: string;
    pool: string;
    quoteMint: string;
    tokenBadge: string | null;
    creator: string;
    feeClaimer: string;
    leftoverReceiver: string;
  };
  requestedConfig: Json;
  signatures: Record<string, string>;
  costsLamports: Record<string, number>;
}

/**
 * Config and series-mint addresses are derived deterministically from the payer
 * and the series symbol. A --dry-run therefore prints the exact addresses a
 * later --execute will create, and running --execute twice fails loudly instead
 * of quietly opening a duplicate market for the same series.
 */
export function derivedKeypair(payer: PublicKey, symbol: string, role: string): Keypair {
  const seed = createHash("sha256").update(`stocklana/market|${payer.toBase58()}|${symbol}|${role}`).digest();
  return Keypair.fromSeed(Uint8Array.from(seed));
}

export function specFromArgs(args: CliFlags, cluster: Cluster): { spec: SeriesSpec; overrides: Partial<CurveOptions>; quoteMint: PublicKey; quoteSymbol: string } {
  const ticker = args.str("underlying", "AAPL") as string;
  const spotOverride = args.num("spot");
  const quoteMintOverride = args.str("quote-mint");
  const underlying = resolveUnderlying(cluster, ticker, {
    ...(quoteMintOverride === undefined ? {} : { quoteMint: quoteMintOverride }),
    ...(spotOverride === undefined ? {} : { spot: spotOverride }),
  });

  const now = args.num("now", Math.floor(Date.now() / 1000)) as number;
  const days = args.num("days", 30) as number;
  const expiryTs = args.num("expiry", Math.floor(now + days * 86400)) as number;
  const spot = underlying.referenceSpot;
  const moneyness = args.num("moneyness");
  const strike = args.num("strike", moneyness === undefined ? Math.round(spot * 1.05) : spot * moneyness) as number;

  const spec: SeriesSpec = {
    underlying: underlying.ticker,
    spot,
    strike,
    expiryTs,
    now,
    contractSize: args.num("contract-size", 1) as number,
    volAnnual: args.num("vol", 0.3) as number,
  };

  const overrides: Partial<CurveOptions> = {};
  for (const [flag, key] of [
    ["contracts", "contracts"],
    ["vol-premium", "inventoryVolPremium"],
    ["segments", "segments"],
    ["rate", "riskFreeRate"],
    ["starting-fee-bps", "startingFeeBps"],
    ["ending-fee-bps", "endingFeeBps"],
    ["creator-fee-pct", "creatorTradingFeePercentage"],
  ] as const) {
    const value = args.num(flag);
    if (value !== undefined) (overrides as Record<string, number>)[key] = value;
  }

  return { spec, overrides, quoteMint: underlying.quoteMint, quoteSymbol: underlying.quoteSymbol };
}

export interface PlannedSeries {
  cluster: Cluster;
  spec: SeriesSpec;
  curve: SeriesCurve;
  symbol: string;
  name: string;
  quoteMint: PublicKey;
  quoteSymbol: string;
  configKeypair: Keypair;
  baseMintKeypair: Keypair;
  pool: PublicKey;
  tokenBadge: PublicKey;
  tokenBadgeExists: boolean;
  payer: PublicKey;
}

export async function planSeries(
  connection: Connection,
  cluster: Cluster,
  payer: PublicKey,
  args: CliFlags,
): Promise<PlannedSeries> {
  const { spec, overrides, quoteMint, quoteSymbol } = specFromArgs(args, cluster);
  const curve = buildSeriesCurve(spec, overrides);
  const symbol = seriesSymbol(spec);

  const configKeypair = derivedKeypair(payer, symbol, "config");
  const baseMintKeypair = derivedKeypair(payer, symbol, "series-mint");
  const pool = deriveDbcPoolAddress(quoteMint, baseMintKeypair.publicKey, configKeypair.publicKey);

  const tokenBadge = deriveTokenBadgeAddress(quoteMint);
  // --no-badge deliberately omits the badge so the failure mode can be
  // demonstrated rather than asserted. On a badged quote mint the program
  // answers InvalidTokenBadge.
  const badgeInfo = args.has("no-badge") ? null : await connection.getAccountInfo(tokenBadge);

  return {
    cluster,
    spec,
    curve,
    symbol,
    name: seriesName(spec),
    quoteMint,
    quoteSymbol,
    configKeypair,
    baseMintKeypair,
    pool,
    tokenBadge,
    tokenBadgeExists: badgeInfo !== null,
    payer,
  };
}

/**
 * One transaction, two instructions. `createConfigAndPool` is the only builder
 * that assembles both offline: `creator.createPool` reads `tokenType` and
 * `quoteMint` back off the config account, so it cannot build a pool for a
 * config that does not exist yet. Atomicity is also what we want here — a config
 * without its pool is a dead account nobody can use.
 */
export async function buildCreateTx(
  client: DynamicBondingCurveClient,
  plan: PlannedSeries,
  metadataUri: string,
): Promise<Transaction> {
  const badge = plan.tokenBadgeExists ? { tokenBadge: plan.tokenBadge } : {};
  return client.partner.createConfigAndPool({
    config: plan.configKeypair.publicKey,
    feeClaimer: plan.payer,
    leftoverReceiver: plan.payer,
    quoteMint: plan.quoteMint,
    payer: plan.payer,
    ...badge,
    ...(plan.curve.config as ConfigParameters),
    preCreatePoolParam: {
      name: plan.name,
      symbol: plan.symbol,
      uri: metadataUri,
      poolCreator: plan.payer,
      baseMint: plan.baseMintKeypair.publicKey,
    },
  });
}

/**
 * A 16-point curve makes `create_config`'s instruction data large enough that
 * config + pool together overflow a legacy transaction (measured: 1408 bytes
 * against the 1232 limit). They are therefore built together — which is how the
 * pool instruction gets built before its config exists — and then sent as two
 * transactions carrying the identical instructions.
 */
export function splitInstructions(tx: Transaction): Transaction[] {
  return tx.instructions.map((ix) => new Transaction().add(ix));
}

/** Wire size without tripping web3.js's own 1232-byte assertion, so an oversized
 *  transaction can be measured and reported rather than only thrown at. */
export function serializedSize(tx: Transaction, payer: PublicKey, blockhash: string): number {
  const probe = new Transaction();
  probe.add(...tx.instructions);
  probe.feePayer = payer;
  probe.recentBlockhash = blockhash;
  const message = probe.serializeMessage();
  return 1 + 64 * probe.compileMessage().header.numRequiredSignatures + message.length;
}

/** Instruction name and named-account count, read out of the DBC IDL by
 *  discriminator. Nothing here is hard-coded. */
function dbcInstructionIndex(): Map<string, { name: string; namedAccounts: number }> {
  const index = new Map<string, { name: string; namedAccounts: number }>();
  for (const ix of DynamicBondingCurveIdl.instructions) {
    const key = Buffer.from(ix.discriminator).toString("hex");
    index.set(key, { name: ix.name, namedAccounts: ix.accounts.length });
  }
  return index;
}

function describeAccounts(plan: PlannedSeries, tx: Transaction): string {
  const lines: string[] = [];
  lines.push(`DBC program      ${DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58()}`);
  lines.push(`quote mint       ${plan.quoteMint.toBase58()}  (${plan.quoteSymbol}, 8 decimals)`);
  lines.push(
    `token badge      ${plan.tokenBadge.toBase58()}  ${plan.tokenBadgeExists ? "EXISTS on chain -> passed as remaining account 0" : "does not exist -> omitted (quote mint must be permissionless-supported)"}`,
  );
  lines.push(`config           ${plan.configKeypair.publicKey.toBase58()}  (deterministic from payer + series symbol)`);
  lines.push(`series mint      ${plan.baseMintKeypair.publicKey.toBase58()}`);
  lines.push(`virtual pool     ${plan.pool.toBase58()}  (PDA of quoteMint, baseMint, config)`);
  lines.push(`payer / creator  ${plan.payer.toBase58()}`);
  lines.push("");

  const index = dbcInstructionIndex();
  tx.instructions.forEach((ix, n) => {
    if (!ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) {
      lines.push(`instruction ${n}: ${ix.programId.toBase58()} (not DBC)`);
      return;
    }
    const discriminator = Buffer.from(ix.data.subarray(0, 8)).toString("hex");
    const meta = index.get(discriminator);
    const named = meta?.namedAccounts ?? 0;
    const remaining = ix.keys.slice(named);
    lines.push(
      `instruction ${n}: ${meta?.name ?? `unknown(${discriminator})`} — ${ix.keys.length} accounts, ${named} named + ${remaining.length} remaining`,
    );
    if (remaining.length === 0) {
      lines.push("  remaining: (none)");
      return;
    }
    remaining.forEach((key, i) => {
      const label = key.pubkey.equals(plan.tokenBadge) ? "   <- token badge for the quote mint" : "";
      lines.push(`  remaining[${i}] ${key.pubkey.toBase58()} signer=${key.isSigner} writable=${key.isWritable}${label}`);
    });
  });
  return lines.join("\n");
}

async function simulate(connection: Connection, tx: Transaction, payer: PublicKey): Promise<boolean> {
  const { blockhash } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer;
  const result = await connection.simulateTransaction(tx, undefined, true);
  console.log(`  err:            ${JSON.stringify(result.value.err)}`);
  console.log(`  units consumed: ${result.value.unitsConsumed ?? "n/a"}`);
  for (const log of result.value.logs ?? []) console.log(`    ${log}`);
  return result.value.err === null;
}

function artifactPath(cluster: Cluster, symbol: string): string {
  return join(ARTIFACT_DIR, `${cluster}-${symbol}.json`);
}

export function writeArtifact(artifact: SeriesArtifact, symbol: string): string {
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  const path = artifactPath(artifact.cluster, symbol);
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return path;
}

async function main(): Promise<void> {
  const args = parseArgs();
  const cluster = resolveCluster(args);
  const dryRun = args.has("dry-run") || (!args.has("execute") && !args.has("simulate"));
  const connection = connect(cluster);
  const wallet = loadKeypair(args.str("keypair"));

  console.log(`cluster          ${cluster}  via ${rpcHost(cluster)}`);
  console.log(`wallet           ${wallet.publicKey.toBase58()}`);
  console.log("");

  // --payer plans the transaction for a different fee payer. Only useful with
  // --simulate, where it lets the real mainnet instruction be executed against
  // live state from an account that already holds SOL, without signing anything.
  const payerOverride = args.str("payer");
  if (payerOverride && !args.has("simulate")) {
    throw new Error("--payer is only allowed together with --simulate");
  }
  const planner = payerOverride ? new PublicKey(payerOverride) : wallet.publicKey;

  const plan = await planSeries(connection, cluster, planner, args);
  console.log(describeCurve(plan.curve));
  console.log("");
  console.log("=== on-chain ConfigParameters ===");
  console.log(describeConfigParameters(plan.curve.config));
  console.log("");

  const client = DynamicBondingCurveClient.create(connection, "confirmed");
  const metadataUri = args.str("uri", "") as string;
  const tx = await buildCreateTx(client, plan, metadataUri);

  console.log("=== accounts ===");
  console.log(describeAccounts(plan, tx));
  console.log("");

  const { blockhash } = await connection.getLatestBlockhash();
  const [configTx, poolTx] = splitInstructions(tx) as [Transaction, Transaction];
  console.log("=== transaction sizes (legacy limit 1232 bytes) ===");
  console.log(`  combined                  ${serializedSize(tx, plan.payer, blockhash)} bytes -> sent as two transactions`);
  console.log(`  create_config             ${serializedSize(configTx, plan.payer, blockhash)} bytes`);
  console.log(`  initialize_virtual_pool   ${serializedSize(poolTx, plan.payer, blockhash)} bytes`);
  console.log("");

  if (cluster === "mainnet" && !plan.tokenBadgeExists && !args.has("no-badge")) {
    throw new Error(
      `No DBC token badge exists for ${plan.quoteMint.toBase58()}. Badges are created by a Meteora operator; refusing to build a config that will fail with InvalidTokenBadge.`,
    );
  }

  if (dryRun) {
    console.log("--dry-run: nothing was sent.");
    return;
  }

  if (args.has("simulate")) {
    // Only create_config can be simulated on its own: the pool instruction
    // reads the config account, which does not exist yet. create_config is also
    // the instruction that validates the quote mint and its token badge, so it
    // is the one worth simulating.
    console.log("=== simulate create_config ===");
    const ok = await simulate(connection, configTx, plan.payer);
    console.log("");
    console.log(ok ? "simulation succeeded against live cluster state." : "simulation returned an error, see above.");
    if (!ok) process.exitCode = 1;
    return;
  }

  const balanceBefore = await connection.getBalance(wallet.publicKey);
  const signatures: Record<string, string> = {};

  console.log("sending create_config ...");
  signatures["createConfig"] = await sendAndConfirmTransaction(connection, configTx, [wallet, plan.configKeypair], {
    commitment: "confirmed",
  });
  console.log(`  ${signatures["createConfig"]}`);
  const balanceAfterConfig = await connection.getBalance(wallet.publicKey);

  console.log("sending initialize_virtual_pool_with_token2022 ...");
  signatures["createPool"] = await sendAndConfirmTransaction(connection, poolTx, [wallet, plan.baseMintKeypair], {
    commitment: "confirmed",
  });
  console.log(`  ${signatures["createPool"]}`);
  const balanceAfterPool = await connection.getBalance(wallet.publicKey);

  const costs = {
    createConfig: balanceBefore - balanceAfterConfig,
    createPool: balanceAfterConfig - balanceAfterPool,
    total: balanceBefore - balanceAfterPool,
  };
  console.log("");
  console.log("measured cost (lamports, rent + fees, from wallet balance deltas):");
  for (const [k, v] of Object.entries(costs)) console.log(`  ${k.padEnd(22)} ${v} (${(v / 1e9).toFixed(9)} SOL)`);

  const artifact: SeriesArtifact = {
    cluster,
    createdAt: new Date().toISOString(),
    dbcProgram: DYNAMIC_BONDING_CURVE_PROGRAM_ID.toBase58(),
    series: toJson({ ...plan.spec, symbol: plan.symbol, name: plan.name, quoteSymbol: plan.quoteSymbol }),
    curveOptions: toJson({ ...DEFAULT_CURVE_OPTIONS, ...plan.curve.options }),
    accounts: {
      config: plan.configKeypair.publicKey.toBase58(),
      baseMint: plan.baseMintKeypair.publicKey.toBase58(),
      pool: plan.pool.toBase58(),
      quoteMint: plan.quoteMint.toBase58(),
      tokenBadge: plan.tokenBadgeExists ? plan.tokenBadge.toBase58() : null,
      creator: wallet.publicKey.toBase58(),
      feeClaimer: wallet.publicKey.toBase58(),
      leftoverReceiver: wallet.publicKey.toBase58(),
    },
    requestedConfig: toJson(plan.curve.config),
    signatures,
    costsLamports: costs,
  };
  const path = writeArtifact(artifact, plan.symbol);
  console.log("");
  console.log(`artifact written to ${path}`);
  console.log(`verify with: pnpm run verify${cluster === "mainnet" ? " --mainnet --yes" : ""} --series=${plan.symbol}`);
}

if (isEntrypoint(import.meta.url)) {
  await main();
}
