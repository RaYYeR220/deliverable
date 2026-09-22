import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { f64ToFixed, SCALE } from '../src/fixed.js';
import { decodeMintState, mintMultiplierAt, type MintState } from '../src/mint.js';
import { currentStrike, exerciseCostAt, strikeAt, uiSizeAt, type SeriesTerms } from '../src/strike.js';
import { fixture } from './helpers.js';

// The real mints, dumped from mainnet 2026-09-22. Each one still carries both sides of
// its split: `multiplier` is the value before, `new_multiplier` the value after, and
// `new_multiplier_effective_timestamp` the instant it changed. The keeper recovered the
// UpdateMultiplier transactions that wrote them:
//   NFLXx ibYRj5Za4VezuyjKTijw... effective 1763337300 (2025-11-16T23:55Z), 1 -> 10
//   CRWDx 2HBgFSMV8FrpEbrBkLBt... effective 1782999000 (2026-07-02T13:30Z), 1 -> 4
const NFLXX = decodeMintState('XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL' as Address, fixture('nflxx_mint.bin'));
const CRWDX = decodeMintState('Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw' as Address, fixture('crwdx_mint.bin'));
const AAPLX = decodeMintState('XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp' as Address, fixture('aaplx_mint.bin'));

const usdc = (dollars: number) => BigInt(Math.round(dollars * 1e6));
const raw = (shares: number) => BigInt(Math.round(shares * 1e8));

/** A series written the instant before the mint's last multiplier change. */
function seriesBefore(mint: MintState, strikeDollars: number, adjust = true): { series: SeriesTerms; before: bigint; after: bigint } {
  const effective = mint.scaledUiAmount!.newMultiplierEffectiveTimestamp;
  const before = effective - 1n;
  return {
    series: {
      strike0: usdc(strikeDollars),
      multiplierAtMint: mintMultiplierAt(mint.scaledUiAmount!, before).effective,
      contractRawSize: raw(1),
      adjustOnCorporateAction: adjust,
      underlyingDecimals: mint.decimals,
    },
    before,
    after: effective,
  };
}

describe('currentStrike against real splits', () => {
  it('the fixtures are the real mints, carrying 1.0 -> 10.0 and 1.0 -> 4.0', () => {
    expect(NFLXX.symbol).toBe('NFLXx');
    expect(NFLXX.scaledUiAmount).toMatchObject({ multiplier: 1, newMultiplier: 10, newMultiplierEffectiveTimestamp: 1763337300n });
    expect(CRWDX.symbol).toBe('CRWDx');
    expect(CRWDX.scaledUiAmount).toMatchObject({ multiplier: 1, newMultiplier: 4, newMultiplierEffectiveTimestamp: 1782999000n });
  });

  it('Netflix 10-for-1: a $500 strike on one share becomes $50 on ten, same notional', () => {
    const { series, before, after } = seriesBefore(NFLXX, 500);
    const pre = currentStrike(series, NFLXX, before);
    const post = currentStrike(series, NFLXX, after);

    expect(pre.multiplier).toBe(SCALE);
    expect(post.multiplier).toBe(10n * SCALE);
    expect(pre.strike).toBe(usdc(500));
    expect(post.strike).toBe(usdc(50));
    expect(post.uiSize).toBe(pre.uiSize * 10n);
    expect(post.notional).toBe(pre.notional);
    expect(post.adjusted).toBe(true);
    // and the holder pays the same dollars for the same raw tokens
    expect(exerciseCostAt(series, post.multiplier, 1n)).toBe(exerciseCostAt(series, pre.multiplier, 1n));
  });

  it('CrowdStrike 4-for-1: $400 becomes $100, same notional', () => {
    const { series, before, after } = seriesBefore(CRWDX, 400);
    const pre = currentStrike(series, CRWDX, before);
    const post = currentStrike(series, CRWDX, after);

    expect(pre.strike).toBe(usdc(400));
    expect(post.strike).toBe(usdc(100));
    expect(post.uiSize).toBe(pre.uiSize * 4n);
    expect(post.notional).toBe(pre.notional);
  });

  it('a real AAPLx dividend step (+6.0 bps) ticks the strike down and holds notional to 1 ppm', () => {
    const { series, before, after } = seriesBefore(AAPLX, 340);
    expect(AAPLX.scaledUiAmount).toMatchObject({ multiplier: 1.0026642075893797, newMultiplier: 1.0032690125398187 });
    const pre = currentStrike(series, AAPLX, before);
    const post = currentStrike(series, AAPLX, after);
    expect(pre.strike).toBe(usdc(340));
    expect(post.strike < usdc(340)).toBe(true);
    expect(post.strike > usdc(339.5)).toBe(true);
    const drift = post.notional > pre.notional ? post.notional - pre.notional : pre.notional - post.notional;
    expect(drift <= pre.notional / 1_000_000n).toBe(true);
    expect(exerciseCostAt(series, post.multiplier, 100n)).toBe(exerciseCostAt(series, post.multiplier, 1n) * 100n);
  });

  it('a split that carries accrued dividends (KLACx 10.016833) needs no classification', () => {
    const series: SeriesTerms = { strike0: usdc(900), multiplierAtMint: SCALE, contractRawSize: raw(1), adjustOnCorporateAction: true, underlyingDecimals: 8 };
    const m1 = f64ToFixed(10.016833);
    const n0 = strikeAt(series, SCALE) * uiSizeAt(series, SCALE);
    const n1 = strikeAt(series, m1) * uiSizeAt(series, m1);
    const drift = n0 > n1 ? n0 - n1 : n1 - n0;
    expect(drift <= n0 / 1_000_000n).toBe(true);
  });

  it('NEGATIVE CONTROL: with adjustment off, the Netflix split moves notional by exactly 10x', () => {
    const { series, before, after } = seriesBefore(NFLXX, 500, false);
    const pre = currentStrike(series, NFLXX, before);
    const post = currentStrike(series, NFLXX, after);
    expect(post.strike).toBe(usdc(500));
    expect(post.notional).toBe(pre.notional * 10n);
    expect(exerciseCostAt(series, post.multiplier, 1n)).toBe(exerciseCostAt(series, pre.multiplier, 1n) * 10n);
  });

  it('exercise cost rounds against the holder', () => {
    const series: SeriesTerms = { strike0: 1n, multiplierAtMint: SCALE, contractRawSize: 3n, adjustOnCorporateAction: true, underlyingDecimals: 8 };
    expect(exerciseCostAt(series, SCALE, 1n)).toBe(1n);
  });

  it('refuses a mint without ScaledUiAmount, as read_multiplier does', () => {
    const { series } = seriesBefore(NFLXX, 500);
    expect(() => currentStrike(series, { ...NFLXX, scaledUiAmount: null })).toThrow(/ScaledUiAmount/);
  });
});
