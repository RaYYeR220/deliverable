import type { Address } from '@solana/kit';
import { describe, expect, it } from 'vitest';

import { US_EQUITY_CALENDAR } from '../src/calendar.js';
import { SCALE } from '../src/fixed.js';
import {
  checkActionable,
  DEFAULT_MAX_CONF_BPS,
  DEFAULT_MAX_DIVERGENCE_BPS,
  DEFAULT_MAX_PRICE_AGE_SECS,
  type GateInputs,
  type GateVerdict,
} from '../src/gate.js';
import type { OracleSource } from '../src/generated/index.js';
import { decodeScopeEntry, divergenceBps, observationToNumber } from '../src/oracle.js';
import { GATE_CHECK_ORDER, REFUSALS, RefusalCode, type RefusalName } from '../src/refusal.js';
import { et, fixture } from './helpers.js';

// A port of programs/deliverable/src/tests/gate_test.rs: one security that is actionable
// in every respect, and each case breaks exactly one thing.

const SCOPE_AAPLX_LAZER = 315;
const SCOPE_AAPLX_CHECKED = 317;
const SCOPE_PRIMARY: OracleSource = { __kind: 'Scope', index: SCOPE_AAPLX_CHECKED };
const SCOPE_SECONDARY: OracleSource = { __kind: 'Scope', index: SCOPE_AAPLX_LAZER };
const PYTH: OracleSource = { __kind: 'Pyth', feedId: new Uint8Array(32).fill(1), maxAge: 3600 };
const HOOK = 'HookProgram1111111111111111111111111111111' as Address;

const SUNDAY_0915Z = 1_789_895_700n;
const OPEN_MONDAY = BigInt(et(2026, 9, 21, 10, 0));
const price = (usd: number) => BigInt(Math.round(usd * 1e8));

function inputs(now: bigint = OPEN_MONDAY): GateInputs {
  return {
    now,
    calendar: US_EQUITY_CALENDAR,
    halt: { halted: false },
    mintPaused: false,
    transferHook: null,
    multiplier: { effective: SCALE, pending: null, epochKey: 0n },
    primarySource: SCOPE_PRIMARY,
    primary: { price: price(336.7021), conf: 0n, expo: -8, publishTs: now - 5n },
    secondary: {
      source: SCOPE_SECONDARY,
      observation: { price: price(334.7685), conf: 0n, expo: -8, publishTs: now - 5n },
    },
    maxAge: DEFAULT_MAX_PRICE_AGE_SECS,
    maxConfBps: DEFAULT_MAX_CONF_BPS,
    maxDivergenceBps: DEFAULT_MAX_DIVERGENCE_BPS,
  };
}

type Breaker = (g: GateInputs) => GateInputs;

/** One way to trip each refusal from an otherwise actionable Monday. */
const BREAK: Record<RefusalName, Breaker> = {
  MarketClosed: (g) => ({ ...g, now: BigInt(et(2026, 11, 27, 15, 0)) }), // the half day, after 13:00
  Halted: (g) => ({ ...g, halt: { halted: true } }),
  IssuerPaused: (g) => ({ ...g, mintPaused: true }),
  HookAttached: (g) => ({ ...g, transferHook: HOOK }),
  MultiplierPending: (g) => ({ ...g, multiplier: { ...g.multiplier, pending: { multiplier: 2n * SCALE, effectiveTs: g.now + 600n } } }),
  OracleStale: (g) => ({ ...g, primary: { ...g.primary, publishTs: g.now - 900n } }),
  ConfidenceBlown: (g) => ({ ...g, primarySource: PYTH, primary: { ...g.primary, conf: (g.primary.price * 250n) / 10_000n } }),
  SingleSource: (g) => ({ ...g, secondary: null }),
  SourcesDisagree: (g) => ({ ...g, secondary: { source: SCOPE_SECONDARY, observation: { ...g.secondary!.observation, price: price(350) } } }),
};

function expectRefusal(verdict: GateVerdict, name: RefusalName) {
  expect(verdict.actionable).toBe(false);
  if (verdict.actionable) return;
  expect(verdict.name).toBe(name);
  expect(verdict.code).toBe(RefusalCode[name]);
  expect(verdict.errorCode).toBe(6000 + RefusalCode[name] - 1);
  expect(verdict.reason.startsWith(REFUSALS[RefusalCode[name]].explanation)).toBe(true);
}

describe('checkActionable mirrors gate.rs', () => {
  it('permits a fresh, corroborated price in an open session', () => {
    expect(checkActionable(inputs())).toEqual({ actionable: true });
  });

  it('refuses when the market is closed even if the price looks fresh', () => {
    const g = { ...inputs(SUNDAY_0915Z), primary: { ...inputs().primary, publishTs: 1_789_895_664n } };
    expectRefusal(checkActionable(g), 'MarketClosed');
  });

  for (const name of Object.keys(BREAK) as RefusalName[]) {
    it(`returns ${name} (code ${RefusalCode[name]}) when only that condition holds`, () => {
      expectRefusal(checkActionable(BREAK[name](inputs())), name);
    });
  }

  it('every pair of conditions resolves to the one gate.rs checks first', () => {
    const names = [...GATE_CHECK_ORDER];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const first = names[i]!;
        const later = names[j]!;
        // SingleSource removes the secondary that SourcesDisagree needs to exist.
        if (first === 'SingleSource' && later === 'SourcesDisagree') continue;
        const g = BREAK[first](BREAK[later](inputs()));
        expectRefusal(checkActionable(g), first);
      }
    }
  });

  it('everything wrong at once still reports MarketClosed: the calendar runs before any oracle', () => {
    let g = inputs(SUNDAY_0915Z);
    // SourcesDisagree is left out: SingleSource has already removed the second source.
    for (const name of GATE_CHECK_ORDER) if (name !== 'MarketClosed' && name !== 'SourcesDisagree') g = BREAK[name](g);
    g = { ...g, primary: { ...g.primary, publishTs: 0n } };
    expectRefusal(checkActionable(g), 'MarketClosed');
  });

  it('a wide band on the corroborating source refuses too', () => {
    const g = inputs();
    const p = price(336.7);
    expectRefusal(
      checkActionable({ ...g, secondary: { source: PYTH, observation: { price: p, conf: (p * 400n) / 10_000n, expo: -8, publishTs: g.primary.publishTs } } }),
      'ConfidenceBlown',
    );
  });

  it('a single source that does publish a band is still refused', () => {
    const g = BREAK.SingleSource({ ...inputs(), primarySource: PYTH, primary: { ...inputs().primary, conf: (price(336.7021) * 10n) / 10_000n } });
    expectRefusal(checkActionable(g), 'SingleSource');
  });

  it('a scheduled dividend weeks out does not close the venue; one inside 30 minutes does', () => {
    const g = inputs();
    const at = (s: bigint) => ({ ...g, multiplier: { ...g.multiplier, pending: { multiplier: 2n * SCALE, effectiveTs: g.now + s } } });
    expect(checkActionable(at(14n * 86_400n)).actionable).toBe(true);
    expect(checkActionable(at(1801n)).actionable).toBe(true);
    expectRefusal(checkActionable(at(1800n)), 'MultiplierPending');
  });

  it('a stale corroborating source refuses like a stale primary', () => {
    const g = inputs();
    expectRefusal(
      checkActionable({ ...g, secondary: { ...g.secondary!, observation: { ...g.secondary!.observation, publishTs: g.now - 900n } } }),
      'OracleStale',
    );
  });

  it('the staleness bound is inclusive at exactly max age', () => {
    const g = inputs();
    expect(checkActionable({ ...g, primary: { ...g.primary, publishTs: g.now - 60n }, secondary: { ...g.secondary!, observation: { ...g.secondary!.observation, publishTs: g.now - 60n } } }).actionable).toBe(true);
    expectRefusal(checkActionable({ ...g, primary: { ...g.primary, publishTs: g.now - 61n } }), 'OracleStale');
  });

  it('a zero price fails as ConfidenceBlown, as the program does', () => {
    const g = inputs();
    expectRefusal(checkActionable({ ...g, primary: { ...g.primary, price: 0n } }), 'ConfidenceBlown');
  });
});

describe('the gate on the real Scope account captured 2026-09-20', () => {
  const scope = fixture('scope_prices.bin');
  const checked = decodeScopeEntry(scope, SCOPE_AAPLX_CHECKED);
  const lazer = decodeScopeEntry(scope, SCOPE_AAPLX_LAZER);

  it('the captured AAPLx entries are the two sources the harness names, 57 bps apart across different exponents', () => {
    // Checked publishes on a 1e-15 grid and PythLazer on 1e-8, which is why to_fixed
    // normalises before comparing.
    expect([checked.expo, lazer.expo]).toEqual([-15, -8]);
    expect(observationToNumber(checked)).toBeCloseTo(336.7021, 4);
    expect(observationToNumber(lazer)).toBeCloseTo(334.7685, 4);
    expect(divergenceBps(checked, lazer)).toBe(57);
  });

  it('with the capture timestamp as now, the refusal is MarketClosed, not staleness', () => {
    const now = checked.publishTs > lazer.publishTs ? checked.publishTs : lazer.publishTs;
    const g: GateInputs = {
      ...inputs(now),
      primary: checked,
      secondary: { source: SCOPE_SECONDARY, observation: lazer },
    };
    expectRefusal(checkActionable(g), 'MarketClosed');
  });

  it('the same two prices, fresh inside a session, are actionable', () => {
    const g: GateInputs = {
      ...inputs(),
      primary: { ...checked, publishTs: OPEN_MONDAY - 5n },
      secondary: { source: SCOPE_SECONDARY, observation: { ...lazer, publishTs: OPEN_MONDAY - 5n } },
    };
    expect(checkActionable(g)).toEqual({ actionable: true });
  });
});
