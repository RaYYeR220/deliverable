import 'server-only';

import {
  confBps,
  describeSource,
  divergenceBps,
  formatFixed,
  GATE_CHECK_ORDER,
  GateArithmeticError,
  mintMultiplierAt,
  MULTIPLIER_QUIET_PERIOD_SECS,
  observationToNumber,
  REFUSALS,
  RefusalCode,
  reportsConfidence,
  resolveSession,
  nextOpen as sdkNextOpen,
  SCOPE_PRICES_ADDRESS,
  type CalendarLike,
  type GateVerdict,
  type MintState,
  type Observation,
  type OracleBinding,
  type OracleSource,
  type GateRefusalName,
} from '@stocklana/sdk';

import { solscan, type Cluster } from '@/lib/config';
import { et, price, refusalTitle, roman, span, utc } from '@/lib/format';
import type { GateBasis, GateRow, GateView, RowStatus, Segment, VerdictView } from '@/lib/types';

/**
 * Everything the gate was evaluated on, plus the verdict the SDK reached. The rows are a
 * reading of the same inputs, one condition at a time, so a person can see the value
 * behind each check. The verdict shown is always the SDK's, never the rows'.
 */
export interface GateEvaluation {
  symbol: string;
  name: string;
  mint: string;
  basis: GateBasis;
  programId: string;
  security: string;
  cluster: Cluster;
  now: bigint;
  calendar: CalendarLike;
  /** Null where this basis cannot observe a halt (no attestation account exists). */
  halt: { halted: boolean; sinceTs: bigint; attestedTs: bigint } | null;
  mintState: MintState;
  binding: OracleBinding;
  primary: Observation;
  secondary: Observation | null;
  labels: ReadonlyMap<number, string>;
  tolerances: { maxAge: number; maxConfBps: number; maxDivergenceBps: number };
  verdict: GateVerdict;
  notes: string[];
  registryPaused: boolean | null;
}

// Keyed by the nine conditions the gate evaluates. Codes 10 and 11 are read
// failures recorded by probe_security, not verdicts, so they are not rows here.
const CHECK_TITLE: Record<GateRefusalName, string> = {
  MarketClosed: 'Session',
  Halted: 'Halt',
  IssuerPaused: 'Issuer pause',
  HookAttached: 'Transfer hook',
  MultiplierPending: 'Multiplier',
  OracleStale: 'Oracle age',
  ConfidenceBlown: 'Confidence',
  SingleSource: 'Second source',
  SourcesDisagree: 'Divergence',
};

type Cell = { value: Segment[]; detail: Segment[]; status: RowStatus };

const text = (t: string): Segment => ({ text: t });
const mono = (t: string): Segment => ({ text: t, mono: true });
const link = (t: string, href: string): Segment => ({ text: t, href, mono: true });

/** The regular session's next close, scanning the SDK's own session resolver minute by minute. */
export function nextClose(calendar: CalendarLike, now: number): number | null {
  if (resolveSession(calendar, now) !== 'Regular') return null;
  let t = Math.floor(now / 60) * 60 + 60;
  for (let i = 0; i < 24 * 60; i++, t += 60) {
    if (resolveSession(calendar, t) === 'Closed') return t;
  }
  return null;
}

/** When the regular session last closed. Null while it is open. */
export function lastClose(calendar: CalendarLike, now: number): number | null {
  if (resolveSession(calendar, now) === 'Regular') return null;
  let t = Math.floor(now / 60) * 60 - 60;
  for (let i = 0; i < 16 * 24 * 60; i++, t -= 60) {
    if (resolveSession(calendar, t) === 'Regular') return t + 60;
  }
  return null;
}

function sourceLabel(source: OracleSource, labels: ReadonlyMap<number, string>): string {
  if (source.__kind !== 'Scope') return describeSource(source);
  const label = labels.get(source.index);
  return label ? `Scope #${source.index} ${label}` : `Scope #${source.index}`;
}

function fixed(value: bigint): string {
  return formatFixed(value, 12);
}

export function buildGateView(e: GateEvaluation): GateView {
  const now = Number(e.now);
  const session = resolveSession(e.calendar, now);
  const opens = session === 'Closed' ? sdkNextOpen(e.calendar, now) : null;
  const closes = nextClose(e.calendar, now);
  const mintHref = solscan('token', e.mint);
  const scopeHref = solscan('account', SCOPE_PRICES_ADDRESS);

  const primarySource = e.binding.primary;
  const secondarySource = e.binding.__kind === 'Pair' ? e.binding.secondary : null;

  // A zero or negative price makes the program fail with ConfidenceBlown wherever it is
  // first normalised; the rows report it the same way.
  let arithmetic: string | null = null;
  const guarded = <T,>(fn: () => T): T | null => {
    try {
      return fn();
    } catch (error) {
      if (error instanceof GateArithmeticError && error.variant === 'ConfidenceBlown') {
        arithmetic = error.message;
        return null;
      }
      throw error;
    }
  };

  const secondaryObservation = e.secondary;
  const apart = secondaryObservation ? guarded(() => divergenceBps(e.primary, secondaryObservation)) : null;

  const cells: Record<GateRefusalName, Cell> = {
    MarketClosed:
      session === 'Closed'
        ? {
            value: [text('Closed')],
            detail: opens
              ? [text(`opens ${et(opens)}, in ${span(opens - now)}`)]
              : [text('no open session within the calendar scan window')],
            status: 'refuse',
          }
        : {
            value: [text('Open, regular session')],
            detail: closes ? [text(`closes ${et(closes)}, in ${span(closes - now)}`)] : [],
            status: 'pass',
          },

    Halted:
      e.halt === null
        ? {
            value: [text('Not observable')],
            detail: [text('No attestation account exists for an unregistered security; the gate reads it as not halted.')],
            status: 'unobservable',
          }
        : e.halt.halted
          ? {
              value: [text('Halted')],
              detail: [text(`since ${utc(Number(e.halt.sinceTs))}, attested ${utc(Number(e.halt.attestedTs))}`)],
              status: 'refuse',
            }
          : {
              value: [text('Not halted')],
              detail:
                e.halt.attestedTs > 0n ? [text(`last attestation ${utc(Number(e.halt.attestedTs))}`)] : [text('no halt has been attested')],
              status: 'pass',
            },

    IssuerPaused: e.mintState.paused
      ? { value: [text('Paused')], detail: [text('Pausable extension set by the issuer on '), link(e.symbol, mintHref)], status: 'refuse' }
      : { value: [text('Not paused')], detail: [text('Pausable extension on '), link(e.symbol, mintHref)], status: 'pass' },

    HookAttached: e.mintState.transferHookProgramId
      ? {
          value: [link(e.mintState.transferHookProgramId, solscan('account', e.mintState.transferHookProgramId))],
          detail: [text('a program now runs inside every transfer of this mint')],
          status: 'refuse',
        }
      : { value: [text('Empty')], detail: [text('transferHook.programId is null on '), link(e.symbol, mintHref)], status: 'pass' },

    MultiplierPending: multiplierCell(e),

    OracleStale: (() => {
      const primaryAge = e.now - e.primary.publishTs;
      const secondaryAge = e.secondary ? e.now - e.secondary.publishTs : null;
      const max = BigInt(e.tolerances.maxAge);
      const stale = primaryAge > max || (secondaryAge !== null && secondaryAge > max);
      return {
        value: [mono(secondaryAge === null ? `${primaryAge} s` : `${primaryAge} s · ${secondaryAge} s`)],
        detail: [
          text(
            `${secondaryAge === null ? 'reported age' : 'primary · secondary, reported ages'}; tolerance ${e.tolerances.maxAge} s`,
          ),
        ],
        status: stale ? 'refuse' : 'pass',
      } satisfies Cell;
    })(),

    ConfidenceBlown: (() => {
      const bands: string[] = [];
      let blown = false;
      for (const [role, source, observation] of [
        ['primary', primarySource, e.primary],
        ['secondary', secondarySource, e.secondary],
      ] as const) {
        if (!source || !observation || !reportsConfidence(source)) continue;
        const band = guarded(() => confBps(observation));
        if (band === null) continue;
        bands.push(`${role} ${band} bps`);
        if (band > e.tolerances.maxConfBps) blown = true;
      }
      if (arithmetic) {
        return { value: [text('Unusable price')], detail: [text('a source printed a zero or negative price')], status: 'refuse' } satisfies Cell;
      }
      if (bands.length === 0) {
        return {
          value: [text('No band published')],
          detail: [text('Scope carries a price and a timestamp, and nothing that says how sure it is. None is synthesised; the second source stands in.')],
          status: 'not-applicable',
        } satisfies Cell;
      }
      return {
        value: [mono(bands.join(' · '))],
        detail: [text(`bound ${e.tolerances.maxConfBps} bps of price`)],
        status: blown ? 'refuse' : 'pass',
      } satisfies Cell;
    })(),

    SingleSource: secondarySource
      ? {
          value: [text('Bound to two sources')],
          detail: [
            link(sourceLabel(primarySource, e.labels), scopeHref),
            text(' checked against '),
            link(sourceLabel(secondarySource, e.labels), scopeHref),
          ],
          status: 'pass',
        }
      : {
          value: [text('One source')],
          detail: [link(sourceLabel(primarySource, e.labels), scopeHref), text(', declared single; nothing corroborates it')],
          status: 'refuse',
        },

    SourcesDisagree: (() => {
      if (!e.secondary) {
        return { value: [text('No second price')], detail: [text('nothing to compare against')], status: 'not-applicable' } satisfies Cell;
      }
      const secondary = e.secondary;
      if (apart === null) {
        return { value: [text('Not computable')], detail: [text('a source printed a zero or negative price')], status: 'not-applicable' } satisfies Cell;
      }
      return {
        value: [mono(`${apart} bps apart`)],
        detail: [
          mono(`${price(observationToNumber(e.primary))} against ${price(observationToNumber(secondary))}`),
          text(`; bound ${e.tolerances.maxDivergenceBps} bps`),
        ],
        status: apart > e.tolerances.maxDivergenceBps ? 'refuse' : 'pass',
      } satisfies Cell;
    })(),
  };

  const decidingIndex = GATE_CHECK_ORDER.findIndex((name) => cells[name].status === 'refuse');
  const rows: GateRow[] = GATE_CHECK_ORDER.map((name, i) => {
    const info = REFUSALS[RefusalCode[name]];
    const cell = cells[name];
    return {
      position: i + 1,
      code: info.code,
      name,
      numeral: roman(info.code),
      check: CHECK_TITLE[name],
      value: cell.value,
      detail: cell.detail,
      status: cell.status,
      reached: decidingIndex < 0 || i <= decidingIndex,
      deciding: i === decidingIndex,
    };
  });

  const verdict: VerdictView = e.verdict.actionable
    ? { actionable: true, code: null, name: null, numeral: null, title: null, message: null, reason: null, errorCode: null }
    : {
        actionable: false,
        code: e.verdict.code,
        name: e.verdict.name,
        numeral: roman(e.verdict.code),
        title: refusalTitle(e.verdict.name),
        message: REFUSALS[e.verdict.code].message,
        reason: e.verdict.reason,
        errorCode: e.verdict.errorCode,
      };

  const decidingName = decidingIndex >= 0 ? GATE_CHECK_ORDER[decidingIndex] : undefined;
  const consistent = e.verdict.actionable ? decidingName === undefined : decidingName === e.verdict.name;

  return {
    symbol: e.symbol,
    name: e.name,
    mint: e.mint,
    basis: e.basis,
    programId: e.programId,
    security: e.security,
    evaluatedAt: now,
    session,
    nextOpen: opens,
    nextClose: closes,
    rows,
    verdict,
    consistent,
    notes: e.notes,
    registryPaused: e.registryPaused,
  };
}

function multiplierCell(e: GateEvaluation): Cell {
  const scaled = e.mintState.scaledUiAmount;
  if (!scaled) {
    return { value: [text('No ScaledUiAmount')], detail: [text('the program will not gate this mint')], status: 'refuse' };
  }
  const m = mintMultiplierAt(scaled, e.now);
  if (m.pending) {
    const until = m.pending.effectiveTs - e.now;
    const inQuiet = until <= MULTIPLIER_QUIET_PERIOD_SECS;
    return {
      value: [mono(`${fixed(m.effective)} → ${fixed(m.pending.multiplier)}`)],
      detail: [
        text(
          `takes effect ${utc(Number(m.pending.effectiveTs))}, in ${span(Number(until))}; quiet period ${Number(MULTIPLIER_QUIET_PERIOD_SECS) / 60} m`,
        ),
      ],
      status: inQuiet ? 'refuse' : 'pass',
    };
  }
  const since = Number(scaled.newMultiplierEffectiveTimestamp);
  return {
    value: [mono(`${fixed(m.effective)} in force`)],
    detail: [text(since > 0 ? `nothing scheduled; last change took effect ${utc(since)}` : 'nothing scheduled; never changed')],
    status: 'pass',
  };
}

export function labelMap(labels: ReadonlyArray<{ index: number; label: string }>): Map<number, string> {
  return new Map(labels.map((l) => [l.index, l.label]));
}

