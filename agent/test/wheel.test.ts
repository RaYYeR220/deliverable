/**
 * The wheel's arithmetic and its three decisions.
 *
 * The pricing assertions are round trips against `callPriceInShares` rather than
 * hard-coded numbers, because the point is that the agent's yield and the venue's curve
 * are the same function. `market/src/curve.ts --selftest` already pins that function to
 * Hull's textbook values and to put-call parity; repeating those here would test the
 * same thing twice.
 */
import { describe, expect, it } from 'vitest';
import { US_EQUITY_CALENDAR, resolveSession } from '@stocklana/sdk';
import { callPriceInShares } from '@stocklana/market/src/curve.ts';

import type { OpenSeries } from '../src/series.ts';
import { UNDERLYINGS } from '../src/underlyings.ts';
import { annualise, buildLadder, hurdleVol, quoteRung, roundStrike, snapToSession } from '../src/yield.ts';
import { planWheel, type WheelInput } from '../src/wheel.ts';

const OPEN = Math.floor(Date.UTC(2026, 8, 22, 17, 0, 0) / 1000);
const AAPL = UNDERLYINGS[0]!;

const rungInput = (overrides: Partial<Parameters<typeof quoteRung>[0]> = {}) => ({
  underlyingTicker: 'AAPL',
  spotUsd: 341.135,
  strikeUsd: 358,
  expiryTs: OPEN + 30 * 86_400,
  now: OPEN,
  contractSize: 1,
  volAnnual: 0.28,
  contracts: 1000,
  riskFreeRate: 0,
  inventoryVolPremium: 0.5,
  hurdleAnnualised: 0.12,
  ...overrides,
});

describe('annualise', () => {
  it('is premium over time, and the contract size cancels', () => {
    const half = annualise(0.01, 1, 0.5);
    expect(half.simple).toBeCloseTo(0.02, 12);
    expect(half.continuous).toBeCloseTo(Math.log(1.01) / 0.5, 12);

    // 100 shares per contract and 100x the premium is the same yield on collateral.
    const hundred = annualise(1.0, 100, 0.5);
    expect(hundred.simple).toBeCloseTo(half.simple, 12);
  });

  it('refuses a non-positive horizon rather than dividing by zero', () => {
    expect(() => annualise(0.01, 1, 0)).toThrow();
  });
});

describe('hurdleVol', () => {
  it('inverts the pricer: the vol it returns reproduces the target yield', () => {
    for (const [moneyness, years, target] of [
      [1.02, 30 / 365.25, 0.2],
      [1.05, 14 / 365.25, 0.15],
      [1.1, 45 / 365.25, 0.1],
    ] as const) {
      const vol = hurdleVol(target, moneyness, years, 0);
      expect(vol).not.toBeNull();
      const premium = callPriceInShares(moneyness, years, vol as number, 0);
      expect(premium / years).toBeCloseTo(target, 8);
    }
  });

  it('is null when the target would breach the no-arbitrage cap', () => {
    // A call is never worth more than one share, so no vol yields 500% annualised over
    // half a year: that would need a premium of 2.5 shares per share.
    expect(hurdleVol(5, 1.0, 0.5, 0)).toBeNull();
  });

  it('is null when 500% vol still does not reach the target', () => {
    expect(hurdleVol(0.99, 3.0, 1.0, 0)).toBeNull();
  });
});

describe('quoteRung', () => {
  it('quotes below the no-arbitrage cap and agrees with the pricer', () => {
    const rung = quoteRung(rungInput());
    expect(rung.quoteSharesPerContract).toBeGreaterThan(0);
    expect(rung.quoteSharesPerContract).toBeLessThan(rung.noArbitrageCapShares);
    expect(rung.topOfLadderShares).toBeLessThan(rung.noArbitrageCapShares);
    // The on-chain sqrt price round-trips to the model premium.
    const model = callPriceInShares(rung.moneyness, rung.years, rung.volAnnual, 0);
    expect(rung.quoteSharesPerContract).toBeCloseTo(model, 6);
  });

  it('pays more for more time at the same strike', () => {
    const short = quoteRung(rungInput({ expiryTs: OPEN + 7 * 86_400 }));
    const long = quoteRung(rungInput({ expiryTs: OPEN + 45 * 86_400 }));
    expect(long.quoteSharesPerContract).toBeGreaterThan(short.quoteSharesPerContract);
  });

  it('pays less the further out of the money the strike is', () => {
    const near = quoteRung(rungInput({ strikeUsd: 348 }));
    const far = quoteRung(rungInput({ strikeUsd: 375 }));
    expect(far.quoteSharesPerContract).toBeLessThan(near.quoteSharesPerContract);
  });

  it('clears the hurdle exactly when the vol parameter is at or above the hurdle vol', () => {
    const rung = quoteRung(rungInput());
    expect(rung.hurdleVol).not.toBeNull();
    expect(rung.clearsHurdle).toBe(rung.volAnnual >= (rung.hurdleVol as number));
  });
});

describe('expiries land where create_series will accept them', () => {
  it('snaps every tenor into a regular session', () => {
    for (const days of [1, 7, 14, 30, 45, 90]) {
      const ts = snapToSession(OPEN + days * 86_400);
      expect(ts).not.toBeNull();
      expect(resolveSession(US_EQUITY_CALENDAR, ts as number)).toBe('Regular');
    }
  });

  it('every rung in a ladder carries a session expiry', () => {
    const ladder = buildLadder({
      ...rungInput(),
      moneyness: [1.02, 1.05, 1.1],
      tenorDays: [7, 14, 30, 45],
    });
    expect(ladder.length).toBe(12);
    for (const rung of ladder) {
      expect(resolveSession(US_EQUITY_CALENDAR, rung.expiryTs)).toBe('Regular');
    }
    // Sorted by annualised yield, best first.
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i - 1]!.premiumYield.simple).toBeGreaterThanOrEqual(ladder[i]!.premiumYield.simple);
    }
  });

  it('rounds strikes onto a human tick', () => {
    expect(roundStrike(358.19)).toBe(358);
    expect(roundStrike(42.3)).toBe(42.5);
    expect(roundStrike(4.27)).toBe(4.3);
  });
});

const actionable = (overrides: Partial<WheelInput> = {}): WheelInput => ({
  underlying: AAPL,
  verdict: { actionable: true },
  now: OPEN,
  spotUsd: 341.135,
  openSeries: [],
  freeContracts: 1000,
  ...overrides,
});

const openSeries = (expiryTs: number, strike = 352): OpenSeries => ({
  source: 'market-artifact',
  cluster: 'devnet',
  symbol: 'AAPL-FIXTURE',
  address: null,
  pool: null,
  expiryTs,
  strike,
  strikeUnits: 'USD per share',
  strikeSpotUsd: 335,
  volAnnual: 0.3,
  contractSize: 1,
  contractsWritten: null,
  phase: null,
  adjusted: null,
  openingQuoteShares: 0.01262378,
  note: 'fixture',
});

describe('the three decisions', () => {
  it('writes when collateral is free and a rung clears', () => {
    const plan = planWheel(actionable());
    expect(plan.decision.kind).toBe('write');
    expect(plan.proposals.map((p) => p.kind)).toEqual(['create_series', 'write']);
  });

  it('holds when no rung clears the hurdle', () => {
    const plan = planWheel(actionable({ parameters: { hurdleAnnualised: 5 } }));
    expect(plan.decision.kind).toBe('hold');
    expect(plan.proposals).toHaveLength(0);
    expect(plan.candidates.every((c) => c.verdict === 'below-hurdle')).toBe(true);
  });

  it('holds when there is less than one contract of collateral', () => {
    const plan = planWheel(actionable({ freeContracts: 0.4 }));
    expect(plan.decision.kind).toBe('hold');
    expect(plan.decision.line).toContain('below one contract');
    expect(plan.proposals).toHaveLength(0);
  });

  it('rolls a series inside its roll window into the best clearing rung', () => {
    const plan = planWheel(actionable({ openSeries: [openSeries(OPEN + 3 * 86_400)] }));
    expect(plan.decision.kind).toBe('roll');
    if (plan.decision.kind !== 'roll') return;
    expect(plan.decision.from.recommendation).toBe('roll');
    expect(plan.decision.to.clearsHurdle).toBe(true);
    expect(plan.proposals.map((p) => p.kind)).toEqual(['create_series', 'write']);
  });

  it('opens the new leg of a roll but will not write against collateral it cannot see', () => {
    const plan = planWheel(actionable({ openSeries: [openSeries(OPEN + 3 * 86_400)], freeContracts: 0 }));
    expect(plan.decision.kind).toBe('roll');
    expect(plan.proposals.map((p) => p.kind)).toEqual(['create_series']);
    expect(plan.notes.join(' ')).toContain('settle_expired');
  });

  it('holds a series with time left and yield still running', () => {
    const plan = planWheel(actionable({ openSeries: [openSeries(OPEN + 40 * 86_400)] }));
    expect(plan.open[0]!.recommendation).toBe('hold');
    expect(plan.open[0]!.line).toContain('Hold');
  });

  it('hands an expired series to settlement rather than to the wheel', () => {
    const plan = planWheel(actionable({ openSeries: [openSeries(OPEN - 86_400)] }));
    expect(plan.open[0]!.recommendation).toBe('settle');
    expect(plan.open[0]!.line).toContain('settle_expired');
  });

  it('prices nothing and proposes nothing when there is no usable spot', () => {
    const plan = planWheel(actionable({ spotUsd: null }));
    expect(plan.candidates).toHaveLength(0);
    expect(plan.proposals).toHaveLength(0);
    expect(plan.decision.kind).toBe('hold');
    expect(plan.notes.join(' ')).toContain('No usable price');
  });

  it('gives one line of reasoning for every candidate', () => {
    const plan = planWheel(actionable());
    expect(plan.candidates.length).toBeGreaterThan(0);
    for (const c of plan.candidates) {
      expect(c.line).toContain(c.rung.symbol);
      expect(c.line).toContain('annualised');
      expect(c.line.split('\n')).toHaveLength(1);
    }
  });
});
