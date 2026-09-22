/**
 * Corporate-action history.
 *
 * The multiplier authority signs a large amount of ordinary Token-2022 traffic (mostly
 * TransferChecked) on the same key it uses for multiplier updates, so a signature list is
 * useless on its own: every instruction has to be decoded and matched on the ScaledUiAmount
 * extension discriminator. See token2022.ts for the discriminator and where it comes from.
 *
 * Strategy: `getSignaturesForAddress` is cheap, `getTransaction` is not. So the scanner pages
 * signatures wide and only fetches transactions inside windows that could plausibly contain an
 * update. Each mint's on-chain `new_multiplier_effective_timestamp` gives the anchor for its
 * own window; --since scans a flat range instead.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classify, type ActionKind } from './classify.ts';
import { flagValue, formatMultiplier, formatPercent, hasFlag, humanDuration, isMainModule, isoOrNull, renderTable } from './format.ts';
import { loadMints, MULTIPLIER_AUTHORITY, type XStock } from './mints.ts';
import { getAccounts, getSignatures, RpcClient } from './rpc.ts';
import { decodeMint, decodeScaledUiAmountInstruction, type UpdateMultiplierInstruction } from './token2022.ts';
import { fetchTransactions, scanSignaturesBackwards, seekSignatureAt } from './transactions.ts';
import { watchMultipliers } from './multiplier-watch.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = resolve(HERE, '..', 'data', 'corporate-actions.json');

/** How far ahead of its effective timestamp an update may have been issued. */
const DEFAULT_LOOKBACK_HOURS = 10;
/** And how long after, in case the authority fires late. */
const DEFAULT_GRACE_HOURS = 2;

export interface CorporateAction {
  mint: string;
  symbol: string;
  signature: string;
  blockTime: number;
  slot: number;
  newMultiplier: number;
  effectiveTimestamp: number;
  /** Seconds between the instruction landing on chain and the multiplier taking effect. */
  leadTimeSeconds: number;
  previousMultiplier: number | null;
  /**
   * Where the old value came from. `same-transaction` is the strong case: the issuer sends
   * UpdateMultiplier twice in one transaction, first re-asserting the value currently in force
   * (with its original effective timestamp) and then scheduling the new one, so both sides of
   * the move are provable from the transaction alone.
   */
  previousMultiplierSource: 'same-transaction' | 'chain-state' | 'prior-action' | 'unknown';
  previousEffectiveTimestamp: number | null;
  ratio: number | null;
  percentChange: number | null;
  classification: ActionKind | null;
  blockTimeIso: string | null;
  effectiveIso: string | null;
  /** How many ScaledUiAmount UpdateMultiplier instructions this transaction carried for this mint. */
  instructionCount: number;
  explorerUrl: string;
}

interface Window {
  from: number;
  to: number;
  label: string;
}

function mergeWindows(windows: Window[]): Window[] {
  const sorted = [...windows].sort((a, b) => a.from - b.from);
  const merged: Window[] = [];
  for (const window of sorted) {
    const last = merged[merged.length - 1];
    if (last && window.from <= last.to) {
      last.to = Math.max(last.to, window.to);
      last.label = `${last.label}, ${window.label}`;
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function parseSince(value: string): number {
  const asDays = Number(value);
  if (Number.isFinite(asDays) && !value.includes('-')) return Math.floor(Date.now() / 1000) - asDays * 86_400;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`--since must be an ISO date or a number of days, got ${value}`);
  return Math.floor(parsed / 1000);
}

function loadExisting(path: string): CorporateAction[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const actions = Array.isArray(parsed) ? parsed : (parsed as { actions?: unknown }).actions;
    return Array.isArray(actions) ? (actions as CorporateAction[]) : [];
  } catch {
    return [];
  }
}

/**
 * The UpdateMultiplier instruction only carries the NEW multiplier. The previous value is
 * reconstructed: for the most recent action on a mint it is the mint's stored `multiplier`
 * field, which Token-2022 snapshots to the value in force at the moment of the update; for
 * older actions it is the `newMultiplier` of the preceding recovered action. Where neither
 * is available the field stays null rather than being guessed.
 */
function resolvePreviousMultipliers(actions: CorporateAction[], chainState: Map<string, number>): void {
  const byMint = new Map<string, CorporateAction[]>();
  for (const action of actions) {
    const list = byMint.get(action.mint) ?? [];
    list.push(action);
    byMint.set(action.mint, list);
  }

  for (const [mint, list] of byMint) {
    list.sort((a, b) => a.blockTime - b.blockTime);
    for (let i = 0; i < list.length; i++) {
      const action = list[i]!;

      // A same-transaction pair already proves the old value; only fill the gap otherwise.
      if (action.previousMultiplierSource !== 'same-transaction') {
        const prior = i > 0 ? list[i - 1] : undefined;
        const isLatest = i === list.length - 1;
        if (prior) {
          action.previousMultiplier = prior.newMultiplier;
          action.previousMultiplierSource = 'prior-action';
          action.previousEffectiveTimestamp = prior.effectiveTimestamp;
        } else if (isLatest && chainState.has(mint)) {
          action.previousMultiplier = chainState.get(mint)!;
          action.previousMultiplierSource = 'chain-state';
        } else {
          action.previousMultiplier = null;
          action.previousMultiplierSource = 'unknown';
        }
      }

      if (action.previousMultiplier !== null) {
        const verdict = classify(action.previousMultiplier, action.newMultiplier);
        action.ratio = verdict.ratio;
        action.percentChange = verdict.percentChange;
        action.classification = verdict.kind;
      }
    }
  }
}

/**
 * The multiplier authority manages more xStock mints than any registry we ship, so a scan
 * legitimately turns up actions on mints we have no symbol for. Rather than print "?", read
 * the symbol out of each unknown mint's own Token-2022 TokenMetadata extension.
 */
async function labelUnknownMints(rpc: RpcClient, actions: CorporateAction[], log: (line: string) => void): Promise<void> {
  const unknown = [...new Set(actions.filter((action) => action.symbol === '?').map((action) => action.mint))];
  if (unknown.length === 0) return;

  log(`resolving symbols for ${unknown.length} mint(s) not in the registry...`);
  const accounts = await getAccounts(rpc, unknown);
  const symbols = new Map<string, string>();
  for (const account of accounts) {
    if (!account) continue;
    const symbol = decodeMint(account.address, account.data)?.metadata?.symbol?.trim();
    if (symbol) symbols.set(account.address, symbol);
  }

  for (const action of actions) {
    const symbol = symbols.get(action.mint);
    if (action.symbol === '?' && symbol) action.symbol = symbol;
  }
}

export interface ScanPlan {
  address: string;
  windows: Window[];
}

/**
 * Two addresses can serve as the haystack for a window: the mint (every instruction that
 * touched it) or the shared multiplier authority. Which one is cheaper depends entirely on
 * how much the token trades — an AMM-quoted mint sees tens of thousands of signatures a day,
 * while the authority sees roughly two thousand. One probe page settles it.
 */
async function probeWindowCost(rpc: RpcClient, address: string, window: Window): Promise<number | null> {
  const startBefore = window.to < Math.floor(Date.now() / 1000) - 600 ? await seekSignatureAt(rpc, window.to) : null;
  const page = await getSignatures(rpc, address, startBefore ? { limit: 1000, before: startBefore } : { limit: 1000 });
  if (page.length === 0) return 0;

  const inWindow = page.filter(
    (record) => record.blockTime !== null && record.blockTime >= window.from && record.blockTime <= window.to,
  ).length;

  const oldest = page[page.length - 1]?.blockTime ?? null;
  // The page reached past the window start, so the count is exact.
  if (page.length < 1000 || (oldest !== null && oldest <= window.from)) return inWindow;

  // Otherwise extrapolate from the density of this page.
  const newest = page[0]?.blockTime ?? null;
  if (newest === null || oldest === null || newest === oldest) return null;
  const perSecond = page.length / (newest - oldest);
  return Math.round(perSecond * (window.to - window.from));
}

export async function recoverActions(
  rpc: RpcClient,
  plan: ScanPlan,
  symbolByMint: Map<string, string>,
  log: (line: string) => void,
): Promise<{ actions: CorporateAction[]; scanned: number; fetched: number }> {
  const now = Math.floor(Date.now() / 1000);
  const candidates: string[] = [];
  let scannedTotal = 0;

  // Each window is seeked independently so the walk never pays for the gaps between them.
  for (const window of plan.windows) {
    const startBefore = window.to < now - 600 ? await seekSignatureAt(rpc, window.to) : null;
    const scan = await scanSignaturesBackwards(rpc, plan.address, {
      stopAtUnixSeconds: window.from,
      ...(startBefore ? { startBefore } : {}),
      keep: (record) => record.blockTime !== null && record.blockTime >= window.from && record.blockTime <= window.to,
      onPage: ({ pages, kept, oldestBlockTime }) => {
        if (pages % 20 === 0) log(`    paged ${pages} (${kept} in window, back to ${isoOrNull(oldestBlockTime) ?? '?'})`);
      },
    });

    scannedTotal += scan.scanned;
    candidates.push(...scan.kept.map((record) => record.signature));
    log(
      `  [${window.label}] ${isoOrNull(window.from)}..${isoOrNull(window.to)}: ${scan.kept.length} candidate(s) ` +
        `from ${scan.scanned} signatures over ${scan.pages} page(s)${startBefore ? ' (seeked)' : ''}`,
    );
  }

  const unique = [...new Set(candidates)];
  log(`  fetching ${unique.length} transaction(s) at ~${rpc.rate.toFixed(1)} req/s`);

  const transactions = await fetchTransactions(rpc, unique, (done, total) => {
    if (done % 960 === 0 || done === total) log(`  decoded ${done}/${total} transactions`);
  });

  const actions: CorporateAction[] = [];
  for (const tx of transactions) {
    if (tx.failed || tx.blockTime === null) continue;

    // Group by mint: the issuer sends a pair per mint, and a single transaction can in
    // principle carry pairs for several mints.
    const perMint = new Map<string, UpdateMultiplierInstruction[]>();
    for (const ix of tx.instructions) {
      const decoded = decodeScaledUiAmountInstruction(ix);
      if (!decoded || decoded.kind !== 'update-multiplier') continue;
      const list = perMint.get(decoded.mint) ?? [];
      list.push(decoded);
      perMint.set(decoded.mint, list);
    }

    for (const [mint, list] of perMint) {
      // The scheduled change is the one with the latest effective timestamp; anything earlier
      // in the same transaction is the issuer pinning the value currently in force.
      const ordered = [...list].sort((a, b) => a.effectiveTimestamp - b.effectiveTimestamp);
      const target = ordered[ordered.length - 1]!;
      const carry = ordered.length > 1 ? ordered[ordered.length - 2]! : null;

      actions.push({
        mint,
        symbol: symbolByMint.get(mint) ?? '?',
        signature: tx.signature,
        blockTime: tx.blockTime,
        slot: tx.slot,
        newMultiplier: target.newMultiplier,
        effectiveTimestamp: target.effectiveTimestamp,
        leadTimeSeconds: target.effectiveTimestamp - tx.blockTime,
        previousMultiplier: carry ? carry.newMultiplier : null,
        previousMultiplierSource: carry ? 'same-transaction' : 'unknown',
        previousEffectiveTimestamp: carry ? carry.effectiveTimestamp : null,
        ratio: null,
        percentChange: null,
        classification: null,
        blockTimeIso: isoOrNull(tx.blockTime),
        effectiveIso: isoOrNull(target.effectiveTimestamp),
        instructionCount: list.length,
        explorerUrl: `https://solscan.io/tx/${tx.signature}`,
      });
    }
  }

  return { actions, scanned: scannedTotal, fetched: transactions.length };
}

async function main(): Promise<void> {
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const registry = loadMints();
  const rpc = new RpcClient(undefined, {
    concurrency: Number(flagValue('concurrency') ?? 3),
    onRetry: ({ attempt, delayMs, reason }) => log(`  rpc retry ${attempt} in ${delayMs}ms (${reason})`),
  });

  const symbolFilter = flagValue('symbol');
  const entries: XStock[] = symbolFilter
    ? registry.mints.filter((entry) => entry.symbol.toLowerCase() === symbolFilter.toLowerCase())
    : registry.mints;
  if (entries.length === 0) throw new Error(`no mint matched --symbol ${symbolFilter}`);

  log(`keeper action-history · rpc ${rpc.host} · ${entries.length} mints from ${registry.source}`);

  const via = flagValue('via') ?? 'auto';
  if (!['auto', 'mint', 'authority'].includes(via)) throw new Error(`--via must be auto, mint or authority`);
  const now = Math.floor(Date.now() / 1000);

  // Read the whole registry even when --symbol narrows the scan: the symbol and multiplier maps
  // are also used to fill in actions already on file, so a narrow run must not degrade them.
  log('reading current mint state to anchor the search windows...');
  const allState = await watchMultipliers(rpc, registry.mints, now);
  const state = symbolFilter ? allState.filter((row) => entries.some((entry) => entry.mint === row.mint)) : allState;
  const symbolByMint = new Map(allState.map((row) => [row.mint, row.symbol]));
  const chainMultiplier = new Map(
    allState.filter((row) => !row.error).map((row) => [row.mint, row.storedMultiplier] as const),
  );

  const lookback = Number(flagValue('lookback-hours') ?? DEFAULT_LOOKBACK_HOURS) * 3_600;
  const grace = Number(flagValue('grace-hours') ?? DEFAULT_GRACE_HOURS) * 3_600;

  const since = flagValue('since');
  const plans: Array<{ address: string; name: string; windows: Window[] }> = [];

  if (since !== undefined) {
    const window = { from: parseSince(since), to: now + 3_600, label: `since ${since}` };
    const address = via === 'mint' && entries.length === 1 ? entries[0]!.mint : MULTIPLIER_AUTHORITY;
    plans.push({ address, name: address === MULTIPLIER_AUTHORITY ? 'multiplier authority' : entries[0]!.symbol, windows: [window] });
  } else {
    const anchored = state
      .filter((row) => row.lastEffectiveAt !== null && !row.error)
      .map((row) => {
        const anchor = Math.floor(Date.parse(row.lastEffectiveAt!) / 1000);
        return { mint: row.mint, symbol: row.symbol, window: { from: anchor - lookback, to: anchor + grace, label: row.symbol } };
      });
    if (anchored.length === 0) {
      throw new Error('no mint carries an effective timestamp, so there is nothing to search for');
    }

    const viaAuthority: Window[] = [];
    const viaMint = new Map<string, { name: string; windows: Window[] }>();

    for (const item of anchored) {
      let pick = via;
      if (via === 'auto') {
        const mintCost = await probeWindowCost(rpc, item.mint, item.window);
        // The authority window is a known ~80 signatures an hour; anything denser is not worth it.
        const authorityCost = Math.round(((item.window.to - item.window.from) / 3_600) * 80);
        pick = mintCost !== null && mintCost <= authorityCost ? 'mint' : 'authority';
        log(`  ${item.symbol}: mint window ~${mintCost ?? 'many'} sigs vs authority ~${authorityCost} -> via ${pick}`);
      }
      if (pick === 'mint') {
        const bucket = viaMint.get(item.mint) ?? { name: item.symbol, windows: [] };
        bucket.windows.push(item.window);
        viaMint.set(item.mint, bucket);
      } else {
        viaAuthority.push(item.window);
      }
    }

    for (const [mint, bucket] of viaMint) plans.push({ address: mint, name: bucket.name, windows: mergeWindows(bucket.windows) });
    if (viaAuthority.length > 0) {
      plans.push({ address: MULTIPLIER_AUTHORITY, name: 'multiplier authority', windows: mergeWindows(viaAuthority) });
    }
  }

  const found: CorporateAction[] = [];
  for (const plan of plans) {
    log(`scanning ${plan.name} (${plan.address}), ${plan.windows.length} window(s)...`);
    const result = await recoverActions(rpc, { address: plan.address, windows: plan.windows }, symbolByMint, log);
    log(`  recovered ${result.actions.length} UpdateMultiplier instruction(s) from ${result.fetched} transactions`);
    found.push(...result.actions);
  }

  const outPath = resolve(flagValue('out') ?? DEFAULT_OUT);
  const previous = hasFlag('fresh') ? [] : loadExisting(outPath);
  const bySignature = new Map<string, CorporateAction>();
  for (const action of [...previous, ...found]) bySignature.set(`${action.signature}:${action.mint}`, action);

  const all = [...bySignature.values()].filter((action) => Number.isFinite(action.blockTime));
  for (const action of all) if (action.symbol === '?') action.symbol = symbolByMint.get(action.mint) ?? '?';
  await labelUnknownMints(rpc, all, log);
  resolvePreviousMultipliers(all, chainMultiplier);
  all.sort((a, b) => b.blockTime - a.blockTime || a.symbol.localeCompare(b.symbol));

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(all, null, 2)}\n`);

  if (hasFlag('json')) {
    process.stdout.write(`${JSON.stringify(all, null, 2)}\n`);
  } else {
    printHuman(all, rpc);
  }
  log(`\nwrote ${all.length} action(s) to ${outPath}`);
  log(`rpc calls: ${rpc.callCount}`);
}

function printHuman(actions: CorporateAction[], rpc: RpcClient): void {
  if (actions.length === 0) {
    process.stdout.write('no UpdateMultiplier instructions found in the scanned windows\n');
    return;
  }

  process.stdout.write(`Recovered corporate actions (${actions.length}) · rpc ${rpc.host}\n\n`);
  process.stdout.write(
    renderTable(actions, [
      { header: 'SYMBOL', get: (row) => row.symbol },
      { header: 'ISSUED (UTC)', get: (row) => row.blockTimeIso ?? '-' },
      { header: 'EFFECTIVE (UTC)', get: (row) => row.effectiveIso ?? '-' },
      { header: 'LEAD', get: (row) => humanDuration(row.leadTimeSeconds), align: 'right' },
      {
        header: 'OLD -> NEW',
        get: (row) =>
          `${row.previousMultiplier === null ? '?' : formatMultiplier(row.previousMultiplier)} -> ${formatMultiplier(row.newMultiplier)}`,
      },
      { header: 'MOVE', get: (row) => (row.percentChange === null ? '?' : formatPercent(row.percentChange)), align: 'right' },
      { header: 'CLASS', get: (row) => row.classification ?? '?' },
      { header: 'SLOT', get: (row) => String(row.slot), align: 'right' },
      { header: 'SIGNATURE', get: (row) => row.signature },
    ]),
  );
  process.stdout.write('\n');
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
