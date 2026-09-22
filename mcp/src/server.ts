/**
 * The Deliverable rail and venue as MCP tools.
 *
 * Every tool is a read. There is deliberately no tool that builds, signs or sends a
 * transaction, and no key is ever loaded: the point of the program is that an agent
 * asking to act gets told "no" by the program, with a typed reason, rather than being
 * handed the means to act and trusted to check first.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { isAddress, type Address } from '@solana/kit';
import {
  currentStrike,
  describeBinding,
  divergenceBps,
  exerciseCostAt,
  formatFixed,
  formatUnits,
  GATE_CHECK_ORDER,
  mintMultiplierAt,
  observationToNumber,
  OptionKind,
  REFUSALS,
  RefusalCode,
  seriesPhase,
  type ActionableResult,
  type AdjustedBalanceResult,
  type Deliverable,
  type MintState,
  type SeriesView,
} from '@stocklana/sdk';
import { z } from 'zod';

import { filterActions, type ActionHistory } from './actions.js';
import type { Underlyings } from './underlyings.js';

export interface ServerDeps {
  client: Deliverable;
  history: ActionHistory;
  underlyings: Underlyings;
  /** Shown to the agent so it knows which cluster it is looking at; never the full URL. */
  rpcHost: string;
}

export const SERVER_NAME = 'deliverable';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = [
  'Read-only view of Deliverable, a Solana program that publishes what is true about a tokenized US stock',
  '(market session, halt, price corroboration, Token-2022 ScaledUiAmount corporate actions) and writes covered calls against it.',
  'Use is_actionable before suggesting any action on an xStock: it returns the refusal code the program itself would return.',
  'Use adjusted_balance for any xStock balance: raw RPC transaction data omits the corporate-action multiplier.',
  'This server cannot sign or send transactions and holds no keys. That is by design.',
].join(' ');

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const iso = (unix: bigint | number | null | undefined): string | null =>
  unix === null || unix === undefined ? null : new Date(Number(unix) * 1000).toISOString();

/** JSON with bigints as decimal strings: every u64/i64 here is exact on-chain data. */
function plain(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) as Record<string, unknown>;
}

function ok(data: Record<string, unknown>): CallToolResult {
  const structured = plain(data);
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

function fail(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return fail(error);
  }
}

const underlyingArg = z
  .string()
  .min(1)
  .describe('xStock symbol (e.g. "AAPLx" or "AAPL") or Token-2022 mint address');

function verdictView(v: ActionableResult) {
  return {
    actionable: v.actionable,
    ...(v.actionable ? {} : { code: v.code, name: v.name, reason: v.reason, anchorErrorCode: v.errorCode }),
    basis: v.basis,
    evaluatedAt: iso(v.evaluatedAt),
    session: v.session,
    nextOpen: iso(v.nextOpen),
    registryPaused: v.registryPaused,
    notes: v.notes,
  };
}

function priceView(v: ActionableResult, now: bigint) {
  const { primary, secondary } = v.observations;
  const one = (o: typeof primary) =>
    o.price === 0n ? null : { usd: observationToNumber(o), publishedAt: iso(o.publishTs), ageSeconds: Number(now - o.publishTs) };
  let divergence: number | null = null;
  try {
    divergence = secondary && primary.price > 0n ? divergenceBps(primary, secondary) : null;
  } catch {
    divergence = null;
  }
  return {
    binding: describeBinding(v.binding),
    primary: one(primary),
    secondary: secondary ? one(secondary) : null,
    divergenceBps: divergence,
  };
}

function multiplierView(mint: MintState, now: bigint) {
  if (!mint.scaledUiAmount) return { extension: false };
  const m = mintMultiplierAt(mint.scaledUiAmount, now);
  const cfg = mint.scaledUiAmount;
  return {
    extension: true,
    // The program's 1e12 fixed-point decode, and the f64 the mint actually stores.
    inForce: formatFixed(m.effective),
    inForceMintValue: now >= cfg.newMultiplierEffectiveTimestamp ? cfg.newMultiplier : cfg.multiplier,
    scheduled: m.pending
      ? {
          multiplier: formatFixed(m.pending.multiplier),
          mintValue: cfg.newMultiplier,
          effectiveAt: iso(m.pending.effectiveTs),
          inSeconds: Number(m.pending.effectiveTs - now),
        }
      : null,
    lastChangeEffectiveAt: m.pending ? null : iso(mint.scaledUiAmount.newMultiplierEffectiveTimestamp),
    authority: mint.scaledUiAmount.authority,
  };
}

function seriesView(series: SeriesView, mint: MintState, now: bigint, calendar: Parameters<typeof seriesPhase>[1] | null) {
  const strike = currentStrike(series, mint, now);
  const q = series.quoteDecimals;
  return {
    address: series.address,
    kind: series.kind === OptionKind.Put ? 'Put' : 'Call',
    expiry: iso(series.expiryTs),
    phase: calendar ? seriesPhase(series, calendar, now) : null,
    strikeAtCreation: formatUnits(series.strike0, q),
    strikeNow: formatUnits(strike.strike, q),
    adjusted: strike.adjusted,
    adjustOnCorporateAction: series.adjustOnCorporateAction,
    multiplierAtCreation: formatFixed(series.multiplierAtMint),
    multiplierNow: formatFixed(strike.multiplier),
    contractSize: {
      raw: series.contractRawSize,
      sharesNow: formatUnits(strike.uiSize, series.underlyingDecimals),
    },
    exerciseCostPerContract: formatUnits(exerciseCostAt(series, strike.multiplier, 1n), q),
    contractsWritten: series.contractsWritten,
    contractsExercised: series.contractsExercised,
    quoteMint: series.quoteMint,
    optionMint: series.optionMint,
  };
}

function balanceView(b: AdjustedBalanceResult) {
  const explanation =
    b.reportedWasScaled === false
      ? `The RPC reported ${b.reported?.uiAmountString} without applying the ScaledUiAmount multiplier ${b.multiplier}; the multiplier-correct figure is ${b.uiAmountString}.`
      : b.reportedWasScaled === true
        ? 'The RPC applied the multiplier on this path; the figure is recomputed from the raw amount and agrees.'
        : 'Recomputed from the raw amount and the multiplier in force.';
  return {
    uiAmount: b.uiAmount,
    uiAmountString: b.uiAmountString,
    raw: b.raw,
    decimals: b.decimals,
    multiplier: b.multiplier,
    multiplierProvenance: b.provenance,
    multiplierAt: iso(b.at),
    mint: b.mint,
    source: b.source,
    accounts: b.accounts,
    ...(b.signature ? { signature: b.signature } : {}),
    ...(b.reported ? { reported: b.reported, reportedWasScaled: b.reportedWasScaled } : {}),
    explanation,
  };
}

function parseSince(since: string): number {
  const days = Number(since);
  if (Number.isFinite(days) && !since.includes('-')) return Math.floor(Date.now() / 1000) - days * 86_400;
  const parsed = Date.parse(since);
  if (Number.isNaN(parsed)) throw new Error(`"since" must be an ISO date or a number of days, got "${since}"`);
  return Math.floor(parsed / 1000);
}

export function createServer(deps: ServerDeps): McpServer {
  const { client, history, underlyings } = deps;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  const programInfo = async () => ({
    address: client.programAddress,
    cluster: deps.rpcHost,
    deployed: await client.programDeployed(),
  });

  server.registerTool(
    'security_state',
    {
      title: 'Security state',
      description:
        'What the rail says about one tokenized stock right now: market session from the committed calendar, the ' +
        'Token-2022 corporate-action multiplier (in force and scheduled), issuer levers (pause, transfer hook), both ' +
        'price sources and their divergence, the on-chain SecurityState if registered, and the gate verdict.',
      inputSchema: { underlying: underlyingArg },
      annotations: READ_ONLY,
    },
    ({ underlying }) =>
      guarded(async () => {
        const { mint, symbol } = underlyings.resolve(underlying);
        const [program, mintState, registered, verdict] = await Promise.all([
          programInfo(),
          client.getMint(mint),
          client.getSecurityState(mint),
          client.isActionable(mint, { preview: true }),
        ]);
        const now = verdict.evaluatedAt;
        return ok({
          underlying: { symbol: mintState.symbol ?? symbol, name: mintState.name, mint, decimals: mintState.decimals },
          program,
          session: { state: verdict.session, at: iso(now), nextOpen: iso(verdict.nextOpen) },
          corporateAction: multiplierView(mintState, now),
          issuerLevers: {
            paused: mintState.paused,
            transferHookProgramId: mintState.transferHookProgramId,
          },
          prices: priceView(verdict, now),
          registered: registered
            ? {
                address: registered.address,
                symbol: registered.symbolText,
                calendarId: registered.calendarId,
                binding: describeBinding(registered.sources),
                observedMultiplier: formatFixed(registered.observedMultiplier),
                multiplierEpoch: registered.multiplierEpoch,
                lastSync: iso(registered.syncedTs),
                halt: {
                  halted: registered.halt.halted,
                  since: iso(registered.halt.sinceTs),
                  attestedAt: iso(registered.halt.attestedTs),
                },
                tolerances: {
                  maxPriceAgeSeconds: registered.maxPriceAge,
                  maxConfidenceBps: registered.maxConfBps,
                  maxDivergenceBps: registered.maxDivergenceBps,
                },
                refusals: {
                  count: registered.refusals,
                  last:
                    registered.lastRefusalCode > 0
                      ? {
                          code: registered.lastRefusalCode,
                          name: REFUSALS[registered.lastRefusalCode as keyof typeof REFUSALS]?.name ?? 'unknown',
                          at: iso(registered.lastRefusalTs),
                        }
                      : null,
                },
              }
            : null,
          gate: verdictView(verdict),
        });
      }),
  );

  server.registerTool(
    'is_actionable',
    {
      title: 'Is actionable',
      description:
        'The refusal gate verdict for one tokenized stock, evaluated off-chain with the same checks in the same order as ' +
        'the program (gate.rs). Returns actionable: true, or the refusal code (1-9), its name and a plain-English reason. ' +
        'basis "registered" means every input came from chain; "preview" means the security is not registered on this ' +
        'cluster and the notes list exactly what was assumed.',
      inputSchema: { underlying: underlyingArg },
      annotations: READ_ONLY,
    },
    ({ underlying }) =>
      guarded(async () => {
        const { mint, symbol } = underlyings.resolve(underlying);
        const verdict = await client.isActionable(mint, { preview: true });
        return ok({ underlying: { symbol, mint }, ...verdictView(verdict), prices: priceView(verdict, verdict.evaluatedAt) });
      }),
  );

  server.registerTool(
    'list_series',
    {
      title: 'List option series',
      description:
        'Covered-call series written on one underlying, each with its strike re-derived from the mint\'s live ' +
        'multiplier (strike0 x m0 / m1), its contract size in shares now, exercise cost per contract and phase.',
      inputSchema: { underlying: underlyingArg },
      annotations: READ_ONLY,
    },
    ({ underlying }) =>
      guarded(async () => {
        const { mint, symbol } = underlyings.resolve(underlying);
        const program = await programInfo();
        if (!program.deployed) {
          return ok({
            underlying: { symbol, mint },
            program,
            series: [],
            note: `The program is not deployed at ${program.address} on ${program.cluster}, so no series exist here.`,
          });
        }
        const [list, mintState, now, security] = await Promise.all([
          client.listSeries(mint),
          client.getMint(mint),
          client.chainTime(),
          client.getSecurityState(mint),
        ]);
        const calendar = security ? await client.getCalendar(security.calendarId) : null;
        return ok({
          underlying: { symbol, mint },
          program,
          at: iso(now),
          series: list.map((s) => seriesView(s, mintState, now, calendar)),
        });
      }),
  );

  server.registerTool(
    'series_detail',
    {
      title: 'Series detail',
      description: 'One option series by address, with its adjusted strike, contract size, phase and book.',
      inputSchema: { series: z.string().min(32).describe('OptionSeries account address') },
      annotations: READ_ONLY,
    },
    ({ series }) =>
      guarded(async () => {
        if (!isAddress(series)) throw new Error(`"${series}" is not a valid address`);
        const program = await programInfo();
        const view = await client.getSeries(series);
        if (!view) {
          return fail(
            program.deployed
              ? `No OptionSeries at ${series} under ${program.address}.`
              : `The program is not deployed at ${program.address} on ${program.cluster}.`,
          );
        }
        const [mintState, now, security] = await Promise.all([
          client.getMint(view.underlyingMint),
          client.chainTime(),
          client.getSecurityState(view.underlyingMint),
        ]);
        const calendar = security ? await client.getCalendar(security.calendarId) : null;
        return ok({
          program,
          at: iso(now),
          underlying: { symbol: underlyings.symbolOf(view.underlyingMint), mint: view.underlyingMint },
          ...seriesView(view, mintState, now, calendar),
          book: {
            contractsWritten: view.contractsWritten,
            contractsExercised: view.contractsExercised,
            quoteCollected: formatUnits(view.quoteCollected, view.quoteDecimals),
            premiumClaimedTotal: view.premiumClaimedTotal,
            windowOpenedAt: view.windowOpenedTs > 0n ? iso(view.windowOpenedTs) : null,
            settlementWindowMinutes: view.settlementWindowMinutes,
          },
          vaults: {
            collateral: view.collateralVault,
            premium: view.premiumVault,
            quote: view.quoteVault,
          },
        });
      }),
  );

  server.registerTool(
    'adjusted_balance',
    {
      title: 'Multiplier-correct balance',
      description:
        'An xStock balance with the Token-2022 ScaledUiAmount multiplier applied, recomputed from the raw amount. ' +
        'getTransaction token balances omit the multiplier; this corrects them at the transaction\'s block time and ' +
        'shows what the RPC reported next to the corrected figure. Give wallet + underlying, or token_account, or ' +
        'signature (with token_account or wallet + underlying to pick the entry), or underlying + supply.',
      inputSchema: {
        underlying: underlyingArg.optional(),
        wallet: z.string().optional().describe('Owner wallet address'),
        token_account: z.string().optional().describe('Token account address'),
        signature: z.string().optional().describe('Transaction signature to read pre/post token balances from'),
        when: z.enum(['pre', 'post']).optional().describe('Which side of the transaction, default post'),
        supply: z.boolean().optional().describe('Total supply of the underlying instead of one holder'),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const mint = args.underlying ? underlyings.resolve(args.underlying).mint : undefined;
        const addr = (value: string | undefined, what: string): Address | undefined => {
          if (value === undefined) return undefined;
          if (!isAddress(value)) throw new Error(`${what} "${value}" is not a valid address`);
          return value;
        };
        const wallet = addr(args.wallet, 'wallet');
        const tokenAccount = addr(args.token_account, 'token_account');

        let result: AdjustedBalanceResult;
        if (args.signature) {
          result = await client.getAdjustedBalance({
            signature: args.signature,
            ...(tokenAccount ? { tokenAccount } : {}),
            ...(wallet ? { owner: wallet } : {}),
            ...(mint ? { mint } : {}),
            ...(args.when ? { when: args.when } : {}),
          });
        } else if (tokenAccount) {
          result = await client.getAdjustedBalance({ tokenAccount });
        } else if (wallet && mint) {
          result = await client.getAdjustedBalance({ owner: wallet, mint });
        } else if (mint && args.supply) {
          result = await client.getAdjustedBalance({ supply: mint });
        } else {
          throw new Error('Give wallet + underlying, token_account, signature, or underlying + supply: true.');
        }
        return ok(balanceView(result));
      }),
  );

  server.registerTool(
    'corporate_actions',
    {
      title: 'Corporate actions',
      description:
        'Recent ScaledUiAmount multiplier changes (dividends, splits, reverse splits) recovered by the keeper from ' +
        'mainnet UpdateMultiplier instructions, newest first, each with its transaction signature. With an underlying, ' +
        'also reads the mint live for a change that is scheduled but not yet in force.',
      inputSchema: {
        underlying: underlyingArg.optional(),
        since: z.string().optional().describe('ISO date, or a number of days back'),
        kind: z.enum(['dividend', 'split', 'reverse-split', 'adjustment']).optional(),
        limit: z.number().int().min(1).max(200).optional().describe('Default 20'),
      },
      annotations: READ_ONLY,
    },
    (args) =>
      guarded(async () => {
        const resolved = args.underlying ? underlyings.resolve(args.underlying) : null;
        const actions = filterActions(history.actions, {
          ...(resolved ? { mint: resolved.mint } : {}),
          ...(args.since ? { sinceUnix: parseSince(args.since) } : {}),
          ...(args.kind ? { kind: args.kind } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        });

        let live: Record<string, unknown> | null = null;
        if (resolved) {
          const [mintState, now] = await Promise.all([client.getMint(resolved.mint), client.chainTime()]);
          const latest = history.actions
            .filter((a) => a.mint === resolved.mint)
            .sort((a, b) => b.effectiveTimestamp - a.effectiveTimestamp)[0];
          const scaled = mintState.scaledUiAmount;
          live = {
            at: iso(now),
            ...multiplierView(mintState, now),
            historyIsCurrent: scaled
              ? latest
                ? latest.effectiveTimestamp === Number(scaled.newMultiplierEffectiveTimestamp) && latest.newMultiplier === scaled.newMultiplier
                : scaled.newMultiplierEffectiveTimestamp === 0n
              : null,
          };
        }

        return ok({
          source: {
            file: history.path,
            records: history.actions.length,
            ...(history.error ? { error: history.error } : {}),
            note: 'Classification is a heuristic on the ratio; the multiplier values and signatures are on-chain facts.',
          },
          ...(resolved ? { underlying: resolved, live } : {}),
          actions: actions.map((a) => ({
            symbol: a.symbol,
            mint: a.mint,
            kind: a.classification,
            previousMultiplier: a.previousMultiplier,
            newMultiplier: a.newMultiplier,
            ratio: a.ratio,
            percentChange: a.percentChange,
            effectiveAt: a.effectiveIso ?? iso(a.effectiveTimestamp),
            announcedAt: a.blockTimeIso ?? iso(a.blockTime),
            leadTimeSeconds: a.leadTimeSeconds,
            signature: a.signature,
            explorerUrl: a.explorerUrl,
          })),
        });
      }),
  );

  server.registerTool(
    'refusal_codes',
    {
      title: 'Refusal codes',
      description: 'The nine refusal codes the program can return, in the order the gate checks them.',
      annotations: READ_ONLY,
    },
    () =>
      guarded(async () =>
        ok({
          checkOrder: GATE_CHECK_ORDER,
          codes: GATE_CHECK_ORDER.map((name) => {
            const info = REFUSALS[RefusalCode[name]];
            return { code: info.code, name: info.name, anchorErrorCode: info.errorCode, message: info.message, meaning: info.explanation };
          }),
        }),
      ),
  );

  return server;
}
