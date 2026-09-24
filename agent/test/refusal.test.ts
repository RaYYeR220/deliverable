/**
 * The agent refuses exactly where the program refuses.
 *
 * Not "the agent has a refusal branch". Each of the nine conditions is built as a set
 * of gate inputs, pushed through `checkActionable` — the SDK's line-for-line port of
 * `gate.rs` — and the verdict that comes back is handed to `planWheel` unchanged. Two
 * things are then asserted:
 *
 *   1. the gate produced the code this case was built to produce, so the case is real
 *      and not a hand-written verdict object that agrees with itself
 *   2. the wheel proposed NOTHING, and said which code stopped it
 *
 * The positive control matters as much: with every input left alone the gate clears,
 * and the same wheel proposes a create_series and a write. A test that only ever sees
 * refusals cannot tell a correct agent from one that never proposes anything at all.
 */
import { describe, expect, it } from 'vitest';
import {
  GATE_CHECK_ORDER,
  REFUSALS,
  RefusalCode,
  US_EQUITY_CALENDAR,
  checkActionable,
  resolveSession,
  type GateInputs,
  type Observation,
  type RefusalName,
} from '@stocklana/sdk';
import type { Address } from '@solana/kit';

import { planWheel, REFUSAL_GUIDANCE, type WheelInput } from '../src/wheel.ts';
import { UNDERLYINGS } from '../src/underlyings.ts';

/** Tuesday 2026-09-22, 13:00 New York. Inside a regular session by the committed calendar. */
const OPEN = BigInt(Math.floor(Date.UTC(2026, 8, 22, 17, 0, 0) / 1000));
/** Sunday 2026-09-20, 09:15 New York. */
const CLOSED = BigInt(Math.floor(Date.UTC(2026, 8, 20, 13, 15, 0) / 1000));

const SCALE = 1_000_000_000_000n;
const AAPL = UNDERLYINGS[0]!;

const observation = (price: bigint, publishTs: bigint, conf = 0n, expo = -8): Observation => ({
  price,
  conf,
  expo,
  publishTs,
});

/** A clean, actionable set of inputs. Every case below perturbs exactly one field. */
function baseInputs(): GateInputs {
  return {
    now: OPEN,
    calendar: US_EQUITY_CALENDAR,
    halt: { halted: false },
    mintPaused: false,
    transferHook: null,
    multiplier: { effective: SCALE, pending: null, epochKey: 0n },
    primarySource: { __kind: 'Scope', index: 317 },
    primary: observation(34_100_000_000n, OPEN - 2n),
    secondary: {
      source: { __kind: 'Scope', index: 315 },
      observation: observation(34_100_000_000n, OPEN - 3n),
    },
    maxAge: 60,
    maxConfBps: 100,
    maxDivergenceBps: 150,
  };
}

const CASES: ReadonlyArray<{ name: RefusalName; inputs: () => GateInputs }> = [
  {
    name: 'MarketClosed',
    inputs: () => ({ ...baseInputs(), now: CLOSED, primary: observation(34_100_000_000n, CLOSED - 2n), secondary: { source: { __kind: 'Scope', index: 315 }, observation: observation(34_100_000_000n, CLOSED - 3n) } }),
  },
  { name: 'Halted', inputs: () => ({ ...baseInputs(), halt: { halted: true } }) },
  { name: 'IssuerPaused', inputs: () => ({ ...baseInputs(), mintPaused: true }) },
  {
    name: 'HookAttached',
    inputs: () => ({ ...baseInputs(), transferHook: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address }),
  },
  {
    name: 'MultiplierPending',
    // Ten minutes out, inside the 30-minute quiet period.
    inputs: () => ({
      ...baseInputs(),
      multiplier: { effective: SCALE, pending: { multiplier: 10n * SCALE, effectiveTs: OPEN + 600n }, epochKey: 0n },
    }),
  },
  {
    name: 'OracleStale',
    inputs: () => ({ ...baseInputs(), primary: observation(34_100_000_000n, OPEN - 120n) }),
  },
  {
    name: 'ConfidenceBlown',
    // Only Pyth reports a confidence band, so this case has to be Pyth-bound: 200 bps
    // of the price against a 100 bps bound.
    inputs: () => ({
      ...baseInputs(),
      primarySource: { __kind: 'Pyth', feedId: new Uint8Array(32), maxAge: 60 },
      primary: observation(34_100_000_000n, OPEN - 2n, 682_000_000n),
    }),
  },
  { name: 'SingleSource', inputs: () => ({ ...baseInputs(), secondary: null }) },
  {
    name: 'SourcesDisagree',
    // 300 bps apart against a 150 bps bound.
    inputs: () => ({
      ...baseInputs(),
      secondary: {
        source: { __kind: 'Scope', index: 315 },
        observation: observation(35_123_000_000n, OPEN - 3n),
      },
    }),
  },
];

function wheelInput(inputs: GateInputs, overrides: Partial<WheelInput> = {}): WheelInput {
  const verdict = checkActionable(inputs);
  return {
    underlying: AAPL,
    verdict,
    now: Number(inputs.now),
    spotUsd: 341.135,
    openSeries: [],
    freeContracts: 1000,
    ...overrides,
  };
}

describe('the calendar fixture is what it claims to be', () => {
  it('OPEN is inside a regular session and CLOSED is not', () => {
    expect(resolveSession(US_EQUITY_CALENDAR, Number(OPEN))).toBe('Regular');
    expect(resolveSession(US_EQUITY_CALENDAR, Number(CLOSED))).toBe('Closed');
  });
});

describe('positive control: the wheel does act when the gate clears', () => {
  it('proposes create_series and write on a clean rail', () => {
    const input = wheelInput(baseInputs());
    expect(input.verdict.actionable).toBe(true);

    const plan = planWheel(input);
    expect(plan.refusal).toBeNull();
    expect(plan.decision.kind).toBe('write');
    expect(plan.proposals.map((p) => p.kind)).toEqual(['create_series', 'write']);
    expect(plan.candidates.some((c) => c.chosen)).toBe(true);
    expect(plan.candidates.every((c) => c.blocked)).toBe(false);
  });
});

describe('every refusal the program can emit stops the wheel', () => {
  for (const testCase of CASES) {
    it(`${RefusalCode[testCase.name]} ${testCase.name}: gate refuses and the wheel proposes nothing`, () => {
      const inputs = testCase.inputs();
      const verdict = checkActionable(inputs);

      // 1. the case really does trip the condition it was built for
      expect(verdict.actionable).toBe(false);
      if (verdict.actionable) return;
      expect(verdict.name).toBe(testCase.name);
      expect(verdict.code).toBe(RefusalCode[testCase.name]);
      expect(verdict.errorCode).toBe(6000 + RefusalCode[testCase.name] - 1);

      // 2. the wheel refuses on exactly that, and does not act
      const plan = planWheel(wheelInput(inputs));
      expect(plan.actionable).toBe(false);
      expect(plan.proposals).toHaveLength(0);
      expect(plan.decision.kind).toBe('refuse');
      if (plan.decision.kind !== 'refuse') return;
      expect(plan.decision.refusal.code).toBe(verdict.code);
      expect(plan.decision.refusal.name).toBe(verdict.name);
      expect(plan.decision.refusal.errorCode).toBe(verdict.errorCode);
      expect(plan.decision.line).toContain(String(verdict.code));
      expect(plan.decision.line).toContain(verdict.name);
      expect(plan.decision.guidance.length).toBeGreaterThan(20);
    });
  }

  it('covers every gate code, in the order gate.rs evaluates them', () => {
    expect(CASES.map((c) => c.name)).toEqual([...GATE_CHECK_ORDER]);
    expect(new Set(CASES.map((c) => c.name)).size).toBe(GATE_CHECK_ORDER.length);
    // The gate decides nine of the eleven. The other two are failures to read an input,
    // recorded by probe_security rather than returned by the gate, so they have no case
    // here — but naming them keeps a newly appended refusal from landing in neither list.
    const names = new Set<string>(Object.keys(RefusalCode));
    for (const name of GATE_CHECK_ORDER) names.delete(name);
    expect([...names].sort()).toEqual(['MultiplierUnreadable', 'OracleUnreadable']);
  });
});

describe('a refusal cannot be worked around', () => {
  it('stays refused however much free collateral there is', () => {
    for (const freeContracts of [0, 1, 1e6]) {
      const plan = planWheel(wheelInput(CASES[1]!.inputs(), { freeContracts }));
      expect(plan.proposals).toHaveLength(0);
      expect(plan.decision.kind).toBe('refuse');
    }
  });

  it('stays refused however low the hurdle is set', () => {
    const plan = planWheel({ ...wheelInput(CASES[0]!.inputs()), parameters: { hurdleAnnualised: 0 } });
    expect(plan.proposals).toHaveLength(0);
    expect(plan.decision.kind).toBe('refuse');
  });

  it('still prices the ladder, and marks every rung as not acted on', () => {
    const plan = planWheel(wheelInput(CASES[0]!.inputs()));
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.candidates.every((c) => c.blocked)).toBe(true);
    expect(plan.candidates.every((c) => !c.chosen)).toBe(true);
    expect(plan.candidates.every((c) => c.line.includes('not acted on'))).toBe(true);
  });

  it('refuses even when an open series is inside its roll window', () => {
    const inputs = CASES[0]!.inputs();
    const plan = planWheel(
      wheelInput(inputs, {
        openSeries: [
          {
            source: 'market-artifact',
            cluster: 'devnet',
            symbol: 'AAPL260925C352',
            address: null,
            pool: null,
            expiryTs: Number(inputs.now) + 2 * 86_400,
            strike: 352,
            strikeUnits: 'USD per share',
            strikeSpotUsd: 335,
            volAnnual: 0.3,
            contractSize: 1,
            contractsWritten: null,
            phase: null,
            adjusted: null,
            openingQuoteShares: 0.01262378,
            note: 'fixture',
          },
        ],
      }),
    );
    expect(plan.decision.kind).toBe('refuse');
    expect(plan.proposals).toHaveLength(0);
  });
});

describe('every code has guidance, and it is the same table the skill document publishes', () => {
  it('every code has a sentence, and no sentence has no code', () => {
    const codes = Object.values(RefusalCode);
    // Not a hard-coded count: the assertion is that the two tables are the same set,
    // so appending a refusal to the SDK fails here until the guidance is written.
    expect(Object.keys(REFUSAL_GUIDANCE).map(Number).sort((a, b) => a - b)).toEqual(
      [...codes].sort((a, b) => a - b),
    );
    for (const code of codes) {
      expect(REFUSALS[code]).toBeDefined();
      expect(REFUSAL_GUIDANCE[code]).toBeTypeOf('string');
      expect(REFUSAL_GUIDANCE[code].length).toBeGreaterThan(40);
    }
  });
});
