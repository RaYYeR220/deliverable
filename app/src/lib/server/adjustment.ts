import 'server-only';

import {
  currentStrike,
  decodeMintState,
  exerciseCostAt,
  mintMultiplierAt,
  type MintState,
  type SeriesTerms,
} from '@stocklana/sdk';

import { multiplier, units } from '@/lib/format';
import type { AdjustmentSide, AdjustmentView, LedgerRow } from '@/lib/types';

import { readRepoBytes } from './repo';
import type { Address } from './rpc';

const QUOTE_DECIMALS = 6;

/**
 * Two real splits replayed through `currentStrike`. The mints are the mainnet dumps the
 * SDK's strike tests assert against; each still records both sides of its split in the
 * ScaledUiAmount extension. The series is written one second before the new multiplier
 * takes effect and read again at the instant it does.
 */
const CASES = [
  {
    symbol: 'NFLXx',
    company: 'NETFLIX',
    ratio: '10-FOR-1',
    mint: 'XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL',
    fixture: 'sdk/test/fixtures/nflxx_mint.bin',
    strikeDollars: 500n,
  },
  {
    symbol: 'CRWDx',
    company: 'CROWDSTRIKE',
    ratio: '4-FOR-1',
    mint: 'Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw',
    fixture: 'sdk/test/fixtures/crwdx_mint.bin',
    strikeDollars: 400n,
  },
] as const;

function side(series: SeriesTerms, mint: MintState, at: bigint, shown: number, symbol: string): AdjustmentSide {
  const s = currentStrike(series, mint, at);
  const decimals = series.underlyingDecimals;
  return {
    multiplier: multiplier(shown),
    strike: `${units(s.strike.toString(), QUOTE_DECIMALS)} USDC`,
    uiSize: `${units(s.uiSize.toString(), decimals)} ${symbol}`,
    // strike (quote units per share) x size (raw units): back to quote units for display
    notional: `${units((s.notional / 10n ** BigInt(decimals)).toString(), QUOTE_DECIMALS)} USDC`,
    exerciseCost: `${units(exerciseCostAt(series, s.multiplier, 1n).toString(), QUOTE_DECIMALS)} USDC`,
  };
}

export function buildAdjustments(ledger: readonly LedgerRow[]): AdjustmentView[] {
  return CASES.map((c) => {
    const mint = decodeMintState(c.mint as Address, readRepoBytes(...c.fixture.split('/')));
    const scaled = mint.scaledUiAmount;
    if (!scaled) throw new Error(`${c.symbol} has no ScaledUiAmount extension`);
    const after = scaled.newMultiplierEffectiveTimestamp;
    const before = after - 1n;

    const series: SeriesTerms = {
      strike0: c.strikeDollars * 10n ** BigInt(QUOTE_DECIMALS),
      multiplierAtMint: mintMultiplierAt(scaled, before).effective,
      contractRawSize: 10n ** BigInt(mint.decimals),
      adjustOnCorporateAction: true,
      underlyingDecimals: mint.decimals,
    };
    const pre = currentStrike(series, mint, before);
    const post = currentStrike(series, mint, after);

    const unadjusted: SeriesTerms = { ...series, adjustOnCorporateAction: false };
    const controlPre = currentStrike(unadjusted, mint, before);
    const controlPost = currentStrike(unadjusted, mint, after);

    const action = ledger.find((r) => r.mint === c.mint && r.effectiveTs === Number(after));

    return {
      symbol: c.symbol,
      company: c.company,
      ratio: c.ratio,
      mint: c.mint,
      signature: action?.signature ?? null,
      effectiveTs: Number(after),
      from: multiplier(scaled.multiplier),
      to: multiplier(scaled.newMultiplier),
      terms: {
        strike0: series.strike0.toString(),
        multiplierAtMint: series.multiplierAtMint.toString(),
        contractRawSize: series.contractRawSize.toString(),
        underlyingDecimals: series.underlyingDecimals,
      },
      before: side(series, mint, before, scaled.multiplier, c.symbol),
      after: side(series, mint, after, scaled.newMultiplier, c.symbol),
      invariantHeld: pre.notional === post.notional,
      control: {
        strike: `${units(controlPost.strike.toString(), QUOTE_DECIMALS)} USDC`,
        uiSize: `${units(controlPost.uiSize.toString(), mint.decimals)} ${c.symbol}`,
        notional: `${units((controlPost.notional / 10n ** BigInt(mint.decimals)).toString(), QUOTE_DECIMALS)} USDC`,
        factor: controlPre.notional > 0n ? (controlPost.notional / controlPre.notional).toString() : '',
      },
      fixture: c.fixture,
    };
  });
}
