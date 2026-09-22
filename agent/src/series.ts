/**
 * Finding the series that already exist on a name, from the two places a series can be.
 *
 *   program        an `OptionSeries` account under the Deliverable program, read with
 *                  `listSeries` and described with the adjusted strike the program
 *                  would charge right now
 *   market artifact a Meteora DBC pool created by `market/src/config.ts`, recorded in
 *                  `market/artifacts/` with the exact `ConfigParameters` that went on
 *                  chain, including the sqrt start price
 *
 * The two are separate on purpose and the report says which is which. The program holds
 * the collateral and the adjustment invariant; the DBC pool holds the price. A series is
 * only fully real when both exist, and today the program is on devnet and its series
 * pools are not on mainnet yet (see PROOF.md, "Deployments").
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Deliverable } from '@stocklana/sdk';

import type { Underlying } from './underlyings.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MARKET_ARTIFACTS = resolve(HERE, '..', '..', 'market', 'artifacts');

export interface OpenSeries {
  source: 'program' | 'market-artifact';
  cluster: string;
  symbol: string;
  /** The series PDA, or the DBC pool for an artifact. */
  address: string | null;
  pool: string | null;
  expiryTs: number;
  /** Strike per adjusted share, in whatever the series is quoted in. */
  strike: number | null;
  strikeUnits: string;
  /** Reference spot the series was struck at, USD. Artifacts record it; the program does not. */
  strikeSpotUsd: number | null;
  volAnnual: number | null;
  contractSize: number | null;
  contractsWritten: number | null;
  phase: string | null;
  /** True when the mint's multiplier has moved since the series was created. */
  adjusted: boolean | null;
  /** Shares per contract the curve opened at, from the sqrt start price that went on chain. */
  openingQuoteShares: number | null;
  note: string;
}

const priceFromSqrtQ64 = (sqrt: string): number => (Number(BigInt(sqrt)) / 2 ** 64) ** 2;

interface MarketArtifact {
  cluster?: string;
  series?: {
    underlying?: string;
    spot?: number;
    strike?: number;
    expiryTs?: number;
    contractSize?: number;
    volAnnual?: number;
    symbol?: string;
    quoteSymbol?: string;
  };
  curveOptions?: { contracts?: number };
  accounts?: { pool?: string; baseMint?: string; quoteMint?: string };
  requestedConfig?: { sqrtStartPrice?: string };
}

/** Every DBC series pool this repository has created for `ticker`. */
export function readMarketArtifacts(ticker: string, dir: string = MARKET_ARTIFACTS): OpenSeries[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'devnet-quote.json');
  } catch {
    return [];
  }

  const out: OpenSeries[] = [];
  for (const file of files) {
    let parsed: MarketArtifact;
    try {
      parsed = JSON.parse(readFileSync(join(dir, file), 'utf8')) as MarketArtifact;
    } catch {
      continue;
    }
    const series = parsed.series;
    if (!series || series.underlying?.toUpperCase() !== ticker.toUpperCase()) continue;
    if (series.expiryTs === undefined || series.symbol === undefined) continue;

    const sqrt = parsed.requestedConfig?.sqrtStartPrice;
    out.push({
      source: 'market-artifact',
      cluster: parsed.cluster ?? 'unknown',
      symbol: series.symbol,
      address: parsed.accounts?.baseMint ?? null,
      pool: parsed.accounts?.pool ?? null,
      expiryTs: series.expiryTs,
      strike: series.strike ?? null,
      strikeUnits: 'USD per share',
      strikeSpotUsd: series.spot ?? null,
      volAnnual: series.volAnnual ?? null,
      contractSize: series.contractSize ?? null,
      contractsWritten: null,
      phase: null,
      adjusted: null,
      openingQuoteShares: sqrt === undefined ? null : priceFromSqrtQ64(sqrt),
      note:
        parsed.cluster === 'devnet'
          ? `devnet, quoted in the ${series.quoteSymbol ?? 'stand-in'} stand-in mint (devnet has no xStocks)`
          : `quoted in ${series.quoteSymbol ?? 'the underlying'}`,
    });
  }
  return out;
}

/**
 * `OptionSeries` accounts on the configured cluster. Returns an empty list when the
 * program is not deployed there, which `getProgramAccounts` reports as no accounts
 * rather than as an error.
 */
export async function readProgramSeries(d: Deliverable, underlying: Underlying): Promise<OpenSeries[]> {
  const views = await d.listSeries(underlying.mint);
  const out: OpenSeries[] = [];
  for (const view of views) {
    const detail = await d.describeSeries(view);
    const grid = 10 ** detail.series.quoteDecimals;
    out.push({
      source: 'program',
      cluster: 'configured',
      symbol: `${underlying.ticker}-${view.address.slice(0, 8)}`,
      address: view.address,
      pool: null,
      expiryTs: Number(view.expiryTs),
      strike: Number(detail.strike.strike) / grid,
      strikeUnits: `quote units per adjusted share (quote mint ${view.quoteMint})`,
      strikeSpotUsd: null,
      volAnnual: null,
      contractSize: Number(detail.strike.uiSize) / 10 ** detail.series.underlyingDecimals,
      contractsWritten: Number(view.contractsWritten),
      phase: detail.phase,
      adjusted: detail.strike.adjusted,
      openingQuoteShares: null,
      note: detail.strike.adjusted
        ? `strike re-cut by a corporate action: ${Number(detail.strike.strike0) / grid} -> ${Number(detail.strike.strike) / grid}, notional invariant`
        : 'strike unchanged since creation',
    });
  }
  return out;
}
