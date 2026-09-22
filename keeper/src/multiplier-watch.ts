/**
 * Corporate-action scanner.
 *
 * Reads every xStock mint, decodes its Token-2022 ScaledUiAmount extension, and reports the
 * multiplier that is actually in force right now plus any pending change. There is no event,
 * no label and no feed for this on Solana — the extension fields are the whole signal.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, isPristine, type ActionKind } from './classify.ts';
import { flagValue, formatMultiplier, formatPercent, hasFlag, humanDuration, isMainModule, isoOrNull, renderTable } from './format.ts';
import { loadMints, MULTIPLIER_AUTHORITY, type XStock } from './mints.ts';
import { getAccounts, RpcClient } from './rpc.ts';
import { decodeMint, effectiveMultiplier, TOKEN_2022_PROGRAM_ID, type MintState } from './token2022.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface PendingChange {
  newMultiplier: number;
  effectiveTimestamp: number;
  effectiveAt: string | null;
  secondsUntilEffective: number;
  percentChange: number;
  ratio: number;
}

export interface MintReport {
  symbol: string;
  mint: string;
  decimals: number;
  supplyRaw: string;
  /** Supply in whole tokens after both decimals and the effective multiplier. */
  supplyScaled: number;
  multiplierAuthority: string | null;
  authorityIsKnown: boolean;
  storedMultiplier: number;
  effectiveMultiplier: number;
  /** True when the stored `multiplier` field is stale because the pending change already landed. */
  pendingAlreadyEffective: boolean;
  lastEffectiveAt: string | null;
  pending: PendingChange | null;
  classification: ActionKind;
  classificationConfidence: 'high' | 'medium' | 'low';
  classificationNote: string;
  error?: string;
}

export interface WatchResult {
  generatedAt: string;
  asOfUnixSeconds: number;
  rpcHost: string;
  mintSource: string;
  mints: MintReport[];
}

function report(entry: XStock, state: MintState | null, now: number): MintReport {
  const base: MintReport = {
    symbol: entry.symbol,
    mint: entry.mint,
    decimals: 0,
    supplyRaw: '0',
    supplyScaled: 0,
    multiplierAuthority: null,
    authorityIsKnown: false,
    storedMultiplier: Number.NaN,
    effectiveMultiplier: Number.NaN,
    pendingAlreadyEffective: false,
    lastEffectiveAt: null,
    pending: null,
    classification: 'none',
    classificationConfidence: 'low',
    classificationNote: '',
  };

  if (!state) return { ...base, error: 'mint account not found' };

  const symbol = state.metadata?.symbol?.trim() || entry.symbol;
  const config = state.scaledUiAmount;
  if (!config) {
    return {
      ...base,
      symbol,
      decimals: state.decimals,
      supplyRaw: state.supply.toString(),
      supplyScaled: Number(state.supply) / 10 ** state.decimals,
      error: 'mint has no ScaledUiAmount extension',
      classificationNote: 'not a scaled-UI-amount token, so it cannot carry a corporate action this way',
    };
  }

  const current = effectiveMultiplier(config, now);
  const alreadyEffective =
    config.newMultiplierEffectiveTimestamp !== 0 && now >= config.newMultiplierEffectiveTimestamp;
  const isPendingInFuture =
    config.newMultiplierEffectiveTimestamp !== 0 && now < config.newMultiplierEffectiveTimestamp;

  let pending: PendingChange | null = null;
  if (isPendingInFuture) {
    const ratio = config.newMultiplier / config.multiplier;
    pending = {
      newMultiplier: config.newMultiplier,
      effectiveTimestamp: config.newMultiplierEffectiveTimestamp,
      effectiveAt: isoOrNull(config.newMultiplierEffectiveTimestamp),
      secondsUntilEffective: config.newMultiplierEffectiveTimestamp - now,
      percentChange: (ratio - 1) * 100,
      ratio,
    };
  }

  // The interesting comparison is the step the issuer actually encoded: stored -> new.
  const verdict = isPristine(current, config.newMultiplierEffectiveTimestamp)
    ? { kind: 'none' as const, confidence: 'high' as const, note: 'never adjusted: multiplier is exactly 1.0 with no effective timestamp' }
    : classify(config.multiplier, config.newMultiplier);

  return {
    symbol,
    mint: entry.mint,
    decimals: state.decimals,
    supplyRaw: state.supply.toString(),
    supplyScaled: (Number(state.supply) / 10 ** state.decimals) * current,
    multiplierAuthority: config.authority,
    authorityIsKnown: config.authority === MULTIPLIER_AUTHORITY,
    storedMultiplier: config.multiplier,
    effectiveMultiplier: current,
    pendingAlreadyEffective: alreadyEffective,
    lastEffectiveAt: isoOrNull(config.newMultiplierEffectiveTimestamp),
    pending,
    classification: verdict.kind,
    classificationConfidence: verdict.confidence,
    classificationNote: verdict.note,
  };
}

export async function watchMultipliers(rpc: RpcClient, entries: XStock[], now = Math.floor(Date.now() / 1000)) {
  const accounts = await getAccounts(rpc, entries.map((entry) => entry.mint));

  return entries.map((entry, i) => {
    const account = accounts[i];
    if (!account) return report(entry, null, now);
    if (account.owner !== TOKEN_2022_PROGRAM_ID) {
      return { ...report(entry, null, now), error: `unexpected owner ${account.owner}` };
    }
    return report(entry, decodeMint(entry.mint, account.data), now);
  });
}

async function main(): Promise<void> {
  const registry = loadMints();
  const only = flagValue('symbol');
  const entries = only
    ? registry.mints.filter((entry) => entry.symbol.toLowerCase() === only.toLowerCase())
    : registry.mints;

  if (entries.length === 0) throw new Error(`no mint matched --symbol ${only}`);

  const rpc = new RpcClient(undefined, {
    onRetry: ({ attempt, delayMs, reason }) =>
      process.stderr.write(`  rpc retry ${attempt} in ${delayMs}ms (${reason})\n`),
  });

  const now = Math.floor(Date.now() / 1000);
  const reports = await watchMultipliers(rpc, entries, now);
  reports.sort((a, b) => a.symbol.localeCompare(b.symbol));

  const result: WatchResult = {
    generatedAt: new Date(now * 1000).toISOString(),
    asOfUnixSeconds: now,
    rpcHost: rpc.host,
    mintSource: registry.source,
    mints: reports,
  };

  if (hasFlag('json')) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result);
  }

  const out = flagValue('out');
  if (out !== undefined) {
    const path = resolve(out || resolve(HERE, '..', 'data', 'multipliers.json'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`\nwrote ${path}\n`);
  }
}

function printHuman(result: WatchResult): void {
  process.stdout.write(`xStocks ScaledUiAmount multipliers @ ${result.generatedAt}\n`);
  process.stdout.write(`rpc ${result.rpcHost} · registry ${result.mintSource} · ${result.mints.length} mints\n\n`);

  process.stdout.write(
    renderTable(result.mints, [
      { header: 'SYMBOL', get: (row) => row.symbol },
      { header: 'DEC', get: (row) => String(row.decimals), align: 'right' },
      {
        header: 'EFFECTIVE MULT',
        get: (row) => (row.error ? '-' : formatMultiplier(row.effectiveMultiplier)),
        align: 'right',
      },
      {
        header: 'STORED MULT',
        get: (row) => (row.error ? '-' : formatMultiplier(row.storedMultiplier)),
        align: 'right',
      },
      {
        header: 'LAST/NEXT EFFECTIVE',
        get: (row) => row.lastEffectiveAt ?? (row.error ? '-' : 'never'),
      },
      {
        header: 'PENDING',
        get: (row) =>
          row.pending
            ? `${formatMultiplier(row.pending.newMultiplier)} in ${humanDuration(row.pending.secondsUntilEffective)}`
            : row.pendingAlreadyEffective
              ? 'applied'
              : '-',
      },
      {
        header: 'MOVE',
        get: (row) => (row.error || row.classification === 'none' ? '-' : formatPercent(row.pending?.percentChange ?? ((row.effectiveMultiplier / row.storedMultiplier - 1) * 100))),
        align: 'right',
      },
      { header: 'CLASS', get: (row) => (row.error ? 'error' : row.classification) },
      { header: 'CONF', get: (row) => (row.error ? '-' : row.classificationConfidence) },
    ]),
  );
  process.stdout.write('\n');

  const pending = result.mints.filter((row) => row.pending);
  if (pending.length > 0) {
    process.stdout.write('\nPending corporate actions\n');
    for (const row of pending) {
      process.stdout.write(
        `  ${row.symbol.padEnd(8)} ${formatMultiplier(row.storedMultiplier)} -> ${formatMultiplier(
          row.pending!.newMultiplier,
        )} (${formatPercent(row.pending!.percentChange)}) effective ${row.pending!.effectiveAt} · ${row.classification}\n`,
      );
    }
  }

  const stale = result.mints.filter((row) => row.pendingAlreadyEffective && row.storedMultiplier !== row.effectiveMultiplier);
  if (stale.length > 0) {
    process.stdout.write(
      `\n${stale.length} mint(s) have a stored multiplier that is already superseded; the effective column is the one to use.\n`,
    );
  }

  const problems = result.mints.filter((row) => row.error);
  for (const row of problems) process.stderr.write(`warning: ${row.symbol} (${row.mint}): ${row.error}\n`);
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
