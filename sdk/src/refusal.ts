/**
 * The nine refusal codes, mirrored from `programs/deliverable/src/error.rs`.
 *
 * Two numberings exist and both are stable. `code` is the `RefusalCode` byte the
 * program writes into the `Refused` event and onto `SecurityState.last_refusal_code`.
 * `errorCode` is the Anchor error a refused instruction fails with: the refusals are
 * the first nine variants of `DeliverableError`, in the same order, so
 * `errorCode = 6000 + code - 1`. test/refusal-codes.test.ts parses error.rs and the
 * IDL and fails if either drifts.
 */
export const RefusalCode = {
  MarketClosed: 1,
  Halted: 2,
  OracleStale: 3,
  ConfidenceBlown: 4,
  MultiplierPending: 5,
  IssuerPaused: 6,
  HookAttached: 7,
  SourcesDisagree: 8,
  SingleSource: 9,
} as const;

export type RefusalName = keyof typeof RefusalCode;
export type RefusalCodeValue = (typeof RefusalCode)[RefusalName];

export interface RefusalInfo {
  code: RefusalCodeValue;
  name: RefusalName;
  /** The Anchor error number a refused instruction fails with. */
  errorCode: number;
  /** The `#[msg]` string on the matching `DeliverableError` variant. */
  message: string;
  /** What the refusal means to someone deciding whether to act. */
  explanation: string;
}

const ANCHOR_ERROR_BASE = 6000;

function info(name: RefusalName, message: string, explanation: string): RefusalInfo {
  const code = RefusalCode[name];
  return { code, name, errorCode: ANCHOR_ERROR_BASE + code - 1, message, explanation };
}

export const REFUSALS: Readonly<Record<RefusalCodeValue, RefusalInfo>> = Object.freeze({
  1: info(
    'MarketClosed',
    'Market is closed for this security',
    'The committed exchange calendar says the US equity market is shut right now (night, weekend, holiday or after an early close). Decided by arithmetic on the clock, before any oracle is read.',
  ),
  2: info(
    'Halted',
    'Trading in this security is halted',
    'A trading halt has been attested for this security by the registry attestor.',
  ),
  3: info(
    'OracleStale',
    'Price is stale inside an open session',
    'The market is open but a price source has not published inside this security\'s staleness tolerance, which during a session means an outage rather than a closed market.',
  ),
  4: info(
    'ConfidenceBlown',
    'Price confidence is too wide to act on',
    'A source that publishes a confidence band published one wider than this security allows, or printed a price that is not usable at all.',
  ),
  5: info(
    'MultiplierPending',
    'A corporate action is pending on this mint',
    'A Token-2022 ScaledUiAmount multiplier change (dividend, split or reverse split) takes effect within the quiet period, so the unit is about to move.',
  ),
  6: info(
    'IssuerPaused',
    'Issuer has paused transfers of this mint',
    'The issuer has set the mint\'s Pausable extension; the token cannot move.',
  ),
  7: info(
    'HookAttached',
    'A transfer hook has been attached to this mint',
    'The mint\'s transfer hook program id is no longer empty, so unknown code would run inside every transfer of the collateral.',
  ),
  8: info(
    'SourcesDisagree',
    'Price sources disagree beyond the allowed divergence',
    'The two independent price sources this security is bound to disagree by more than its divergence bound.',
  ),
  9: info(
    'SingleSource',
    'Security is bound to a single price source and nothing corroborates it',
    'The security is registered against one price source, and one number nothing can contradict is not treated as a price.',
  ),
});

/**
 * The order `check_actionable` in gate.rs evaluates its conditions. It is not the
 * numeric order: the calendar runs first because it is the cheapest check and the one
 * that holds most of the week, and the issuer levers run before any oracle is read.
 * The test suite parses gate.rs and asserts this list against it.
 */
export const GATE_CHECK_ORDER: readonly RefusalName[] = Object.freeze([
  'MarketClosed',
  'Halted',
  'IssuerPaused',
  'HookAttached',
  'MultiplierPending',
  'OracleStale',
  'ConfidenceBlown',
  'SingleSource',
  'SourcesDisagree',
]);

export function refusalInfo(code: number): RefusalInfo | undefined {
  return (REFUSALS as Record<number, RefusalInfo | undefined>)[code];
}

/** Map an Anchor error number from a failed transaction back to a refusal, if it is one. */
export function refusalFromErrorCode(errorCode: number): RefusalInfo | undefined {
  return refusalInfo(errorCode - ANCHOR_ERROR_BASE + 1);
}
