/**
 * The shapes the server hands the browser. Plain JSON: no bigint, no SDK types, so the
 * client bundle never pulls in the SDK or anything that can reach the RPC.
 */

/** A fragment of a displayed value. Linked fragments point at an explorer. */
export interface Segment {
  text: string;
  href?: string;
  mono?: boolean;
}

/**
 * `pass` and `refuse` are the condition's own outcome. `not-applicable` is a check the
 * program skips for this source; `unobservable` is an input this basis cannot read.
 */
export type RowStatus = 'pass' | 'refuse' | 'not-applicable' | 'unobservable';

export interface GateRow {
  /** 1..9, the position in the program's check order. */
  position: number;
  /** The refusal code this check emits. */
  code: number;
  name: string;
  numeral: string;
  check: string;
  value: Segment[];
  detail: Segment[];
  status: RowStatus;
  /** False once an earlier check has refused: the program never evaluates it. */
  reached: boolean;
  /** The check that decided the verdict. */
  deciding: boolean;
}

export interface VerdictView {
  actionable: boolean;
  code: number | null;
  name: string | null;
  numeral: string | null;
  title: string | null;
  message: string | null;
  reason: string | null;
  errorCode: number | null;
}

export type GateBasis = 'registered' | 'preview';

export interface GateView {
  symbol: string;
  name: string;
  mint: string;
  basis: GateBasis;
  programId: string;
  security: string;
  evaluatedAt: number;
  session: 'Closed' | 'Regular';
  nextOpen: number | null;
  nextClose: number | null;
  rows: GateRow[];
  verdict: VerdictView;
  /** The rows' first refusal is the SDK verdict. Shown if it ever is not. */
  consistent: boolean;
  notes: string[];
  registryPaused: boolean | null;
}

export type Sourced<T> = { ok: true; value: T } | { ok: false; error: string };

export interface BasisRow {
  symbol: string;
  mint: string;
  scopeIndex: number;
  scopeLabel: string | null;
  oraclePrice: number;
  oracleTs: number;
  oracleSlot: number | null;
  reportedAge: number;
  /** The mint's ScaledUiAmount multiplier in force at the read: shares per unscaled token. */
  multiplier: number | null;
  /** `oraclePrice / multiplier`: the oracle in the unit the market price is quoted in. */
  oraclePerShare: number | null;
  /** jup.ag `usdPrice`, per share. */
  marketPrice: number | null;
  /** Like for like: (market - oracle per share) / oracle per share. */
  basisBps: number | null;
  /** (market - oracle) / oracle, mixing units. Shown so the correction stays visible. */
  basisBareBps: number | null;
  /** Present on a pinned record: the second sample against the first. */
  moved?: number;
  tsAdvanced?: number;
  slotAdvanced?: number;
}

export interface BasisView {
  source: 'live' | 'pinned';
  /** Unix seconds. Chain clock for a live read, the snapshot time for a pinned one. */
  at: number;
  slot: number | null;
  session: 'Closed' | 'Regular';
  /** When the regular session last closed, per the committed calendar. */
  lastClose: number | null;
  rows: BasisRow[];
  market: { ok: boolean; error: string | null; source: string };
  gapSeconds: number | null;
  /** Pinned only: the file the record came from. */
  record: string | null;
  /** Where the multipliers came from, in words. */
  multiplierSource: string;
}

export interface RailSnapshot {
  mode: 'live' | 'preview';
  readAt: number;
  gates: Array<{ symbol: string; mint: string; result: Sourced<GateView> }>;
  basis: Sourced<BasisView>;
}

export interface PinnedAccount {
  what: string;
  pubkey: string;
  file: string;
  captured: string;
  sha256: string;
}

export interface ReplayData {
  clock: number;
  gates: Array<{ symbol: string; mint: string; result: Sourced<GateView> }>;
  basis: Sourced<BasisView>;
  accounts: PinnedAccount[];
}

export interface AdjustmentSide {
  multiplier: string;
  strike: string;
  uiSize: string;
  notional: string;
  exerciseCost: string;
}

export interface AdjustmentView {
  symbol: string;
  company: string;
  ratio: string;
  mint: string;
  signature: string | null;
  effectiveTs: number;
  from: string;
  to: string;
  terms: { strike0: string; multiplierAtMint: string; contractRawSize: string; underlyingDecimals: number };
  before: AdjustmentSide;
  after: AdjustmentSide;
  invariantHeld: boolean;
  control: { strike: string; uiSize: string; notional: string; factor: string };
  fixture: string;
}

export interface LedgerRow {
  symbol: string;
  mint: string;
  signature: string;
  slot: number;
  blockTime: number;
  effectiveTs: number;
  leadSeconds: number;
  previous: number;
  next: number;
  classification: string;
  inWindow: boolean;
}

export interface SeriesRow {
  address: string;
  symbol: string;
  underlyingMint: string;
  kind: string;
  expiryTs: number;
  strike0: string;
  strike: string;
  adjusted: boolean;
  uiSize: string;
  phase: string | null;
  contractsWritten: string;
  contractsExercised: string;
}

export type SeriesSnapshot =
  | { configured: false; cluster: string }
  | { configured: true; cluster: string; programId: string; deployed: false }
  | { configured: true; cluster: string; programId: string; deployed: true; series: SeriesRow[] };
