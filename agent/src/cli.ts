/**
 * Wheelwright. One command, one pass:
 *
 *   read the rail  ->  list what is open  ->  price the ladder  ->  decide  ->  print
 *
 * and if the rail refuses, stop at step one and say which of the nine codes stopped it.
 *
 *   pnpm run wheel --underlying=AAPL
 *   pnpm run wheel --underlying=NVDA --hurdle=0.18 --tenors=7,14,30 --moneyness=1.02,1.05
 *   pnpm run wheel --all --json
 *   pnpm run wheel --underlying=AAPL --writer=<pubkey>     # sizes on real collateral,
 *                                                          # and compiles the unsigned tx
 */
import type { Address } from '@solana/kit';
import { createDeliverable, mintMultiplierAt, resolveRpcUrl, rpcHost } from '@stocklana/sdk';

import { parseArgs } from './args.ts';
import { buildProposals, DEFAULT_QUOTE_DECIMALS, DEFAULT_QUOTE_MINT, type Proposal } from './propose.ts';
import { readRail, type RailRead } from './rail.ts';
import { renderPlan, renderRail, type ReportContext } from './report.ts';
import { readMarketArtifacts, readProgramSeries, type OpenSeries } from './series.ts';
import { resolveUnderlying, UNDERLYINGS, type Underlying } from './underlyings.ts';
import { planWheel, type WheelParameters, type WheelPlan } from './wheel.ts';

interface Run {
  rail: RailRead;
  plan: WheelPlan;
  proposals: Proposal[];
  context: ReportContext;
}

async function runOne(
  d: ReturnType<typeof createDeliverable>,
  underlying: Underlying,
  options: {
    preview: boolean;
    at: number | undefined;
    writer: Address | null;
    assumeCollateral: boolean;
    contracts: number;
    quoteMint: Address;
    quoteDecimals: number;
    settlementWindowMinutes: number;
    calendarId: number;
    parameters: Partial<WheelParameters>;
    host: string;
  },
): Promise<Run> {
  const rail = await readRail(d, underlying, {
    preview: options.preview,
    ...(options.at === undefined ? {} : { at: options.at }),
  });

  const openSeries: OpenSeries[] = [...readMarketArtifacts(underlying.ticker)];
  try {
    openSeries.push(...(await readProgramSeries(d, underlying)));
  } catch (error) {
    // getProgramAccounts is the one read a public endpoint commonly refuses. Say so
    // rather than silently reporting "no open series", which would be a different claim.
    rail.verdict.notes.push(
      `Could not list on-chain series: ${error instanceof Error ? error.message : String(error)}. ` +
        'Only recorded market artifacts are shown.',
    );
  }

  const contractSize = options.parameters.contractSize ?? 1;
  let freeContracts = options.contracts;
  let freeContractsSource = 'assumed from --contracts: no wallet was given, so this is the size the wheel would use, not a balance';
  if (options.writer && !options.assumeCollateral) {
    try {
      const balance = await d.getAdjustedBalance({ owner: options.writer, mint: underlying.mint });
      freeContracts = balance.uiAmount / contractSize;
      freeContractsSource = `multiplier-correct balance of ${options.writer}: ${balance.uiAmount} adjusted shares via ${balance.provenance}`;
    } catch (error) {
      freeContracts = 0;
      freeContractsSource = `balance read failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else if (options.writer) {
    freeContractsSource = `ASSUMED from --contracts with --assume-collateral. ${options.writer} has not been read; do not treat this size as backed.`;
  }

  const plan = planWheel({
    underlying,
    verdict: rail.verdict.actionable
      ? { actionable: true }
      : { actionable: false, code: rail.verdict.code, name: rail.verdict.name, reason: rail.verdict.reason, errorCode: rail.verdict.errorCode },
    now: rail.evaluatedAt,
    spotUsd: rail.pricePerShareUsd,
    openSeries,
    freeContracts,
    parameters: options.parameters,
  });

  let proposals: Proposal[] = [];
  if (plan.proposals.length > 0) {
    const scaled = rail.mint.scaledUiAmount;
    const multiplierFixed = scaled ? mintMultiplierAt(scaled, BigInt(rail.evaluatedAt)).effective : 1_000_000_000_000n;
    const blockhash = options.writer ? (await d.rpc.getLatestBlockhash().send()).value : undefined;
    proposals = await buildProposals(plan.proposals, {
      programAddress: d.programAddress,
      underlyingMint: underlying.mint,
      underlyingDecimals: rail.mint.decimals,
      multiplierFixed,
      quoteMint: options.quoteMint,
      quoteDecimals: options.quoteDecimals,
      writer: options.writer,
      binding: rail.verdict.binding,
      settlementWindowMinutes: options.settlementWindowMinutes,
      calendarId: options.calendarId,
      ...(blockhash ? { blockhash } : {}),
    });
  }

  return {
    rail,
    plan,
    proposals,
    context: {
      rpcHost: options.host,
      programAddress: d.programAddress,
      cluster: 'configured by SOLANA_RPC_URL',
      writer: options.writer,
      freeContracts,
      freeContractsSource,
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.has('help')) {
    console.log(HELP);
    return;
  }

  const parameters: Partial<WheelParameters> = {
    hurdleAnnualised: args.num('hurdle', 0.12),
    rollWithinDays: args.num('roll-within', 7),
    riskFreeRate: args.num('rate', 0),
    contractSize: args.num('contract-size', 1),
    contracts: args.num('contracts', 1000),
    inventoryVolPremium: args.num('vol-premium', 0.5),
  };
  const moneyness = args.list('moneyness');
  if (moneyness) parameters.moneyness = moneyness;
  const tenors = args.list('tenors');
  if (tenors) parameters.tenorDays = tenors;

  const url = resolveRpcUrl();
  const host = rpcHost(url);
  const d = createDeliverable();

  const writerFlag = args.str('writer');
  const targets = args.has('all')
    ? UNDERLYINGS
    : [resolveUnderlying(args.str('underlying', 'AAPL'))];

  const options = {
    preview: !args.has('no-preview'),
    at: args.num('at'),
    writer: (writerFlag ?? null) as Address | null,
    assumeCollateral: args.has('assume-collateral'),
    contracts: args.num('contracts', 1000),
    quoteMint: (args.str('quote-mint') ?? DEFAULT_QUOTE_MINT) as Address,
    quoteDecimals: args.num('quote-decimals', DEFAULT_QUOTE_DECIMALS),
    settlementWindowMinutes: args.num('settlement-window', 390),
    calendarId: args.num('calendar', 0),
    parameters,
    host,
  };

  const runs: Run[] = [];
  const failures: string[] = [];
  for (const underlying of targets) {
    // A vol parameter override only makes sense for a single name.
    const volOverride = args.num('vol');
    const target = volOverride === undefined ? underlying : { ...underlying, volAnnual: volOverride };
    try {
      runs.push(await runOne(d, target, options));
    } catch (error) {
      failures.push(`${underlying.ticker}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // A name that cannot be read is reported, not swallowed. Three of the nine carry no
  // Scope Checked/PythLazer pair today, so a preview has nothing to bind them to; that
  // is a fact about the feed, not a failure of the run that read the other six.
  for (const failure of failures) console.error(`not read  ${failure}`);
  if (runs.length === 0) process.exitCode = 1;

  if (args.has('json')) {
    console.log(
      JSON.stringify(
        runs.map((r) => ({
          underlying: r.plan.underlying,
          evaluatedAt: r.rail.evaluatedAt,
          basis: r.rail.verdict.basis,
          session: r.rail.verdict.session,
          actionable: r.plan.actionable,
          refusal: r.plan.refusal,
          guidance: r.plan.decision.kind === 'refuse' ? r.plan.decision.guidance : null,
          pricePerShareUsd: r.rail.pricePerShareUsd,
          multiplier: r.rail.multiplier,
          pendingMultiplier: r.rail.pendingMultiplier,
          openSeries: r.plan.open.map((s) => ({ symbol: s.series.symbol, source: s.series.source, cluster: s.series.cluster, daysToExpiry: s.daysToExpiry, recommendation: s.recommendation, reasoning: s.line })),
          candidates: r.plan.candidates.map((c) => ({
            symbol: c.rung.symbol,
            strikeUsd: c.rung.strikeUsd,
            days: c.rung.days,
            moneyness: c.rung.moneyness,
            quoteSharesPerContract: c.rung.quoteSharesPerContract,
            annualisedSimple: c.rung.premiumYield.simple,
            annualisedContinuous: c.rung.premiumYield.continuous,
            hurdleVol: c.rung.hurdleVol,
            volParameter: c.rung.volAnnual,
            verdict: c.verdict,
            chosen: c.chosen,
            blocked: c.blocked,
            reasoning: c.line,
          })),
          decision: { kind: r.plan.decision.kind, line: r.plan.decision.line },
          proposals: r.proposals,
        })),
        (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
        2,
      ),
    );
    return;
  }

  for (const run of runs) {
    console.log('');
    console.log(renderRail(run.rail, run.context));
    console.log(renderPlan(run.plan, run.context, run.proposals));
    console.log('');
  }
}

const HELP = `Wheelwright — a covered-call wheel operator for tokenised equities.

  pnpm run wheel [flags]

  --underlying=AAPL        ticker, xStock symbol or mint. Default AAPL.
  --all                    every name in src/underlyings.ts
  --writer=<pubkey>        size on this wallet's multiplier-correct balance, and
                           compile the unsigned transactions with it as fee payer
  --contracts=1000         series supply, and the assumed size when no --writer is given
  --assume-collateral      with --writer, size at --contracts instead of reading the
                           wallet's balance. Labelled as assumed in the output.
  --contract-size=1        underlying shares per contract
  --hurdle=0.12            annualised premium yield a rung must clear
  --moneyness=1.02,1.05    strike ladder, K/S
  --tenors=7,14,30,45      tenors in days
  --roll-within=7          roll an open series once it has fewer days left than this
  --vol=0.28               override the volatility PARAMETER for one name
  --rate=0                 risk-free rate
  --quote-mint=<pubkey>    what exercise is paid in. Default USDC.
  --quote-decimals=6       decimals of that mint
  --settlement-window=390  exercise window, in minutes of open-market time
  --at=<unix>              evaluate the gate at this instant instead of the chain clock,
                           e.g. a Sunday to see the calendar refuse before any oracle
                           is read
  --no-preview             fail instead of previewing when the mint is not registered
  --json                   machine-readable output
  --help

The agent holds no key and signs nothing. It prints the transactions a human sends.`;

await main();
