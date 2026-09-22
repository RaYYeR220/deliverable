/**
 * The report. One screen per underlying: what the rail said, what already exists, what
 * the wheel would write, what it decided, and the exact bytes a human would sign.
 *
 * Nothing here logs an RPC URL or an API key. `rpcHost` exists in the SDK for that
 * reason and is the only form of an endpoint this file will print.
 */
import type { Proposal } from './propose.ts';
import type { RailRead } from './rail.ts';
import type { WheelPlan } from './wheel.ts';

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const iso = (unix: number) => new Date(unix * 1000).toISOString().replace('.000Z', 'Z');

export interface ReportContext {
  rpcHost: string;
  programAddress: string;
  cluster: string;
  writer: string | null;
  freeContracts: number;
  freeContractsSource: string;
}

export function renderRail(rail: RailRead, ctx: ReportContext): string {
  const v = rail.verdict;
  const lines: string[] = [];
  lines.push(`${rail.underlying.ticker} / ${rail.underlying.symbol}  ${rail.underlying.mint}`);
  lines.push(`  rpc ${ctx.rpcHost}   program ${ctx.programAddress}   basis ${v.basis}   at ${iso(rail.evaluatedAt)}`);
  lines.push(`  session          ${v.session}${v.nextOpen === null ? '' : `, next regular open ${iso(v.nextOpen)}`}`);

  if (v.actionable) {
    lines.push('  gate             ACTIONABLE');
  } else {
    lines.push(`  gate             REFUSED ${v.code} ${v.name}  (Anchor error ${v.errorCode})`);
    lines.push(`                   ${v.reason}`);
  }

  if (rail.pricePerShareUsd === null) {
    lines.push('  price            unavailable: the oracle read did not produce a usable observation');
  } else {
    lines.push(
      `  price            $${(rail.pricePerTokenUsd ?? 0).toFixed(6)} per token / ${rail.multiplier.toFixed(12)} = ` +
        `$${rail.pricePerShareUsd.toFixed(6)} per adjusted share`,
    );
  }
  lines.push(
    `  multiplier       ${rail.multiplier.toFixed(12)}` +
      (rail.pendingMultiplier
        ? `   PENDING ${rail.pendingMultiplier.multiplier.toFixed(12)} at ${iso(rail.pendingMultiplier.effectiveTs)}`
        : ''),
  );
  if (rail.divergenceBps !== null) lines.push(`  source spread    ${rail.divergenceBps} bps between the two bound sources`);
  lines.push(`  issuer levers    paused ${rail.mint.paused}   transfer hook ${rail.mint.transferHookProgramId ?? 'none'}`);
  if (v.registryPaused) lines.push('  registry         PAUSED: write and exercise fail with RegistryPaused whatever the gate says');
  for (const note of v.notes) lines.push(`  note             ${note}`);
  return lines.join('\n');
}

export function renderPlan(plan: WheelPlan, ctx: ReportContext, proposals: readonly Proposal[]): string {
  const lines: string[] = [];

  lines.push('');
  lines.push(`open series on ${plan.underlying.ticker}`);
  if (plan.open.length === 0) {
    lines.push('  none. The program holds no OptionSeries for this mint on this cluster, and');
    lines.push('  market/artifacts records no DBC pool for it.');
  } else {
    for (const s of plan.open) {
      lines.push(`  [${s.series.source}/${s.series.cluster}] ${s.line}`);
      if (s.series.pool) lines.push(`      pool ${s.series.pool}   ${s.series.note}`);
      if (s.series.openingQuoteShares !== null) {
        lines.push(`      curve opened at ${s.series.openingQuoteShares.toFixed(8)} shares per contract`);
      }
    }
  }

  lines.push('');
  lines.push(
    `candidate rungs  (vol parameter ${pct(plan.underlying.volAnnual)}, hurdle ${pct(plan.parameters.hurdleAnnualised)} annualised, ` +
      `${plan.parameters.contracts} contracts, ${plan.parameters.contractSize} share per contract)`,
  );
  if (plan.candidates.length === 0) {
    lines.push('  none priced.');
  } else {
    for (const c of plan.candidates) lines.push(`  ${c.line}`);
  }

  lines.push('');
  lines.push(`collateral       ${ctx.freeContracts.toFixed(4)} contracts free (${ctx.freeContractsSource})`);
  lines.push('');
  lines.push(`DECISION         ${plan.decision.kind.toUpperCase()}`);
  lines.push(`                 ${plan.decision.line}`);
  if (plan.decision.kind === 'refuse') {
    lines.push(`                 what to do: ${plan.decision.guidance}`);
  }
  for (const note of plan.notes) lines.push(`                 ${note}`);

  lines.push('');
  if (plan.proposals.length === 0) {
    lines.push('proposed transactions: none.');
    if (plan.refusal) {
      lines.push('  The gate refused, so nothing is proposed. This is the rule, not a fallback:');
      lines.push('  there is no size, strike or tenor at which a refused security becomes writable.');
    }
  } else {
    lines.push(`proposed transactions: ${proposals.length}  (UNSIGNED — this agent holds no key)`);
    for (const p of proposals) {
      lines.push('');
      lines.push(`  ${p.title}`);
      lines.push(`    ${p.summary}`);
      for (const ix of p.instructions) {
        lines.push(`    program ${ix.programAddress}`);
        for (const a of ix.accounts) {
          const role = `${a.signer ? 's' : '-'}${a.writable ? 'w' : '-'}`;
          lines.push(`      ${role}  ${a.name.padEnd(22)} ${a.address}`);
        }
        lines.push(`      data  ${ix.dataHex}`);
      }
      lines.push(`    ${p.note}`);
      if (p.unsignedTransactionBase64) {
        lines.push(`    fee payer ${p.feePayer}   blockhash ${p.blockhash}`);
        lines.push(`    unsigned transaction (base64, signature slots zeroed):`);
        lines.push(`      ${p.unsignedTransactionBase64}`);
      }
    }
  }

  return lines.join('\n');
}
