import 'server-only';

import { OptionKind } from '@stocklana/sdk';

import { CLUSTER, PROGRAM_ID, SECURITIES } from '@/lib/config';
import { units } from '@/lib/format';
import type { SeriesRow, SeriesSnapshot } from '@/lib/types';

import { deliverable, type Address } from './rpc';

const QUOTE_DECIMALS = 6;

/**
 * Series on the two gated securities, each with the strike it carries now. Nothing is
 * read until a deployment is configured: without one there is no program to ask.
 */
export async function readSeries(): Promise<SeriesSnapshot> {
  if (!PROGRAM_ID) return { configured: false, cluster: CLUSTER };
  const d = deliverable();
  if (!(await d.programDeployed())) return { configured: true, cluster: CLUSTER, programId: PROGRAM_ID, deployed: false };

  const listed = await Promise.all(
    SECURITIES.map(async (security) => ({ security, series: await d.listSeries(security.mint as Address) })),
  );
  const rows: SeriesRow[] = [];
  for (const { security, series } of listed) {
    for (const s of series) {
      const detail = await d.describeSeries(s);
      rows.push({
        address: s.address,
        symbol: security.symbol,
        underlyingMint: s.underlyingMint,
        kind: s.kind === OptionKind.Put ? 'Put' : 'Call',
        expiryTs: Number(s.expiryTs),
        strike0: units(s.strike0.toString(), QUOTE_DECIMALS),
        strike: units(detail.strike.strike.toString(), QUOTE_DECIMALS),
        adjusted: detail.strike.adjusted,
        uiSize: units(detail.strike.uiSize.toString(), s.underlyingDecimals),
        phase: detail.phase,
        contractsWritten: s.contractsWritten.toString(),
        contractsExercised: s.contractsExercised.toString(),
      });
    }
  }
  return { configured: true, cluster: CLUSTER, programId: PROGRAM_ID, deployed: true, series: rows };
}
