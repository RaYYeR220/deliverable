import 'server-only';

import { OptionKind } from '@stocklana/sdk';

import { CLUSTER, DEVNET_LIVE, PROGRAM_ID, SECURITIES } from '@/lib/config';
import { units } from '@/lib/format';
import type { SeriesRow, SeriesSnapshot } from '@/lib/types';

import { STANDIN_MINT } from './devnet';
import { deliverable, devnetDeliverable, type Address } from './rpc';

const QUOTE_DECIMALS = 6;

/**
 * Series on the gated securities, each with the strike it carries now. Nothing is read
 * until a deployment is configured: without one there is no program to ask. The
 * securities asked about are the ones that exist on the cluster the program is on:
 * AAPLx and NVDAx on mainnet, the registered stand-in on devnet.
 */
export async function readSeries(): Promise<SeriesSnapshot> {
  if (!PROGRAM_ID) return { configured: false, cluster: CLUSTER };
  const d = DEVNET_LIVE ? devnetDeliverable() : deliverable();
  const universe =
    DEVNET_LIVE && STANDIN_MINT ? [{ symbol: 'AAPLd', name: 'AAPLx devnet stand-in', mint: STANDIN_MINT }] : SECURITIES;
  if (!(await d.programDeployed())) return { configured: true, cluster: CLUSTER, programId: PROGRAM_ID, deployed: false };

  const listed = await Promise.all(
    universe.map(async (security) => ({ security, series: await d.listSeries(security.mint as Address) })),
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
  return {
    configured: true,
    cluster: CLUSTER,
    programId: PROGRAM_ID,
    deployed: true,
    securities: universe.map((s) => s.symbol),
    series: rows,
  };
}
