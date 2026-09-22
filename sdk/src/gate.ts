/**
 * `check_actionable` from `programs/deliverable/src/gate.rs`, evaluated off-chain.
 *
 * The order of the checks is the program's, not the numeric order of the codes, and it
 * matters: the first failing condition is the code the program emits. GATE_CHECK_ORDER
 * in refusal.ts records the same order and the test suite checks both against gate.rs.
 */
import type { Address } from '@solana/kit';

import type { OracleSource } from './generated/index.js';
import { resolveSession, type CalendarLike } from './calendar.js';
import type { MintMultiplier } from './mint.js';
import { confBps, divergenceBps, GateArithmeticError, reportsConfidence, type Observation } from './oracle.js';
import { REFUSALS, RefusalCode, type RefusalCodeValue, type RefusalName } from './refusal.js';

/** `constants::MULTIPLIER_QUIET_PERIOD_SECS`. */
export const MULTIPLIER_QUIET_PERIOD_SECS = 30n * 60n;
/** `constants::DEFAULT_MAX_PRICE_AGE_SECS`, `DEFAULT_MAX_CONF_BPS`, `DEFAULT_MAX_DIVERGENCE_BPS`. */
export const DEFAULT_MAX_PRICE_AGE_SECS = 60;
export const DEFAULT_MAX_CONF_BPS = 100;
export const DEFAULT_MAX_DIVERGENCE_BPS = 150;

/** Mirrors `gate::GateInputs`. */
export interface GateInputs {
  now: bigint;
  calendar: CalendarLike;
  halt: { halted: boolean };
  mintPaused: boolean;
  transferHook: Address | null;
  multiplier: MintMultiplier;
  primarySource: OracleSource;
  primary: Observation;
  /** `None` only for a security registered as `SingleDeclared`. */
  secondary: { source: OracleSource; observation: Observation } | null;
  maxAge: number;
  maxConfBps: number;
  maxDivergenceBps: number;
}

export type GateVerdict =
  | { actionable: true }
  | {
      actionable: false;
      code: RefusalCodeValue;
      name: RefusalName;
      /** Plain English: what the code means and the specific numbers that tripped it. */
      reason: string;
      /** The Anchor error a refused instruction fails with (6000 + code - 1). */
      errorCode: number;
    };

function refuse(name: RefusalName, detail: string): GateVerdict {
  const info = REFUSALS[RefusalCode[name]];
  return {
    actionable: false,
    code: info.code,
    name: info.name,
    reason: `${info.explanation} ${detail}`.trim(),
    errorCode: info.errorCode,
  };
}

const age = (now: bigint, publishTs: bigint): bigint => now - publishTs;

/**
 * Evaluate the gate. Returns the verdict the program would reach on the same inputs.
 *
 * Where the program's gate fails with an error instead of a refusal (a zero or negative
 * price reaching `conf_bps` or `divergence_bps`), the instruction fails with
 * `ConfidenceBlown` all the same, just without the `Refused` event, so it is reported as
 * that refusal. `MathOverflow` has no refusal code and is thrown.
 */
export function checkActionable(g: GateInputs): GateVerdict {
  if (resolveSession(g.calendar, Number(g.now)) === 'Closed') {
    return refuse('MarketClosed', `Evaluated at ${new Date(Number(g.now) * 1000).toISOString()}.`);
  }
  if (g.halt.halted) {
    return refuse('Halted', '');
  }
  if (g.mintPaused) {
    return refuse('IssuerPaused', '');
  }
  if (g.transferHook !== null) {
    return refuse('HookAttached', `Hook program: ${g.transferHook}.`);
  }
  if (g.multiplier.pending) {
    const until = g.multiplier.pending.effectiveTs - g.now;
    if (until <= MULTIPLIER_QUIET_PERIOD_SECS) {
      return refuse(
        'MultiplierPending',
        `The new multiplier takes effect in ${until}s at ${new Date(Number(g.multiplier.pending.effectiveTs) * 1000).toISOString()}; the quiet period is ${MULTIPLIER_QUIET_PERIOD_SECS}s.`,
      );
    }
  }
  const maxAge = BigInt(g.maxAge);
  const primaryAge = age(g.now, g.primary.publishTs);
  if (primaryAge > maxAge) {
    return refuse('OracleStale', `Primary source is ${primaryAge}s old; tolerance is ${g.maxAge}s.`);
  }
  if (g.secondary) {
    const secondaryAge = age(g.now, g.secondary.observation.publishTs);
    if (secondaryAge > maxAge) {
      return refuse('OracleStale', `Secondary source is ${secondaryAge}s old; tolerance is ${g.maxAge}s.`);
    }
  }

  try {
    if (reportsConfidence(g.primarySource)) {
      const bps = confBps(g.primary);
      if (bps > g.maxConfBps) {
        return refuse('ConfidenceBlown', `Primary band is ${bps} bps of price; the bound is ${g.maxConfBps} bps.`);
      }
    }
    if (g.secondary && reportsConfidence(g.secondary.source)) {
      const bps = confBps(g.secondary.observation);
      if (bps > g.maxConfBps) {
        return refuse('ConfidenceBlown', `Secondary band is ${bps} bps of price; the bound is ${g.maxConfBps} bps.`);
      }
    }

    if (!g.secondary) {
      return refuse('SingleSource', '');
    }
    const bps = divergenceBps(g.primary, g.secondary.observation);
    if (bps > g.maxDivergenceBps) {
      return refuse('SourcesDisagree', `The sources are ${bps} bps apart; the bound is ${g.maxDivergenceBps} bps.`);
    }
  } catch (error) {
    if (error instanceof GateArithmeticError && error.variant === 'ConfidenceBlown') {
      return refuse('ConfidenceBlown', 'A source printed a zero or negative price.');
    }
    throw error;
  }

  return { actionable: true };
}
