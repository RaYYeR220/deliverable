import 'server-only';

import {
  decodeScopeEntry,
  DEFAULT_MAX_CONF_BPS,
  DEFAULT_MAX_DIVERGENCE_BPS,
  DEFAULT_MAX_PRICE_AGE_SECS,
  NotRegisteredError,
  observationToNumber,
  resolveSession,
  SCOPE_ENTRY_SIZE,
  SCOPE_PRICES_ADDRESS,
  SCOPE_PRICES_OFFSET,
  SCOPE_PROGRAM_ADDRESS,
  US_EQUITY_CALENDAR,
  type CalendarLike,
  type ScopeLabel,
} from '@stocklana/sdk';

import { CLUSTER, CLUSTER_LABEL, SECURITIES } from '@/lib/config';
import type { BasisRow, BasisView, GateView, RailSnapshot, Sourced } from '@/lib/types';

import { BASIS_FEEDS, JUPITER_PRICE_V3 } from './feeds';
import { buildGateView, labelMap, lastClose } from './gate';
import { deliverable, describeFailure, PROGRAM_ADDRESS, SourceUnavailable, type Address } from './rpc';

const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111' as Address;
/** `Clock` layout: slot u64 | epoch_start_timestamp i64 | epoch u64 | leader_schedule_epoch u64 | unix_timestamp i64. */
const CLOCK_UNIX_TIMESTAMP_OFFSET = 32;
/** Scope `DatedPrice`: value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64. */
const SCOPE_SLOT_OFFSET = 16;

type Security = (typeof SECURITIES)[number];

async function settle<T>(work: Promise<T>): Promise<Sourced<T>> {
  try {
    return { ok: true, value: await work };
  } catch (error) {
    return { ok: false, error: describeFailure(error) };
  }
}

async function readGate(security: Security, mode: 'live' | 'preview'): Promise<GateView> {
  const d = deliverable();
  const mint = security.mint as Address;
  let result;
  try {
    result = await d.isActionable(mint, mode === 'preview' ? { preview: true } : {});
  } catch (error) {
    if (error instanceof NotRegisteredError) {
      throw new SourceUnavailable(
        `No SecurityState for ${security.symbol} under ${PROGRAM_ADDRESS} on ${CLUSTER_LABEL[CLUSTER]}: the program is not deployed there, or ${security.symbol} is not registered.`,
      );
    }
    throw error;
  }

  const [mintState, labels, state] = await Promise.all([
    d.getMint(mint),
    d.scopeLabels().catch((): ScopeLabel[] => []),
    result.basis === 'registered' ? d.getSecurityState(mint) : Promise.resolve(null),
  ]);

  let calendar: CalendarLike = US_EQUITY_CALENDAR;
  if (state) {
    const onChain = await d.getCalendar(state.calendarId);
    if (!onChain) throw new SourceUnavailable(`Calendar ${state.calendarId} for ${security.symbol} could not be read.`);
    calendar = onChain;
  }

  return buildGateView({
    symbol: security.symbol,
    name: security.name,
    mint: security.mint,
    basis: result.basis,
    programId: PROGRAM_ADDRESS,
    security: result.security,
    cluster: CLUSTER,
    now: result.evaluatedAt,
    calendar,
    halt: state ? state.halt : null,
    mintState,
    binding: result.binding,
    primary: result.observations.primary,
    secondary: result.observations.secondary,
    labels: labelMap(labels),
    tolerances: state
      ? { maxAge: state.maxPriceAge, maxConfBps: state.maxConfBps, maxDivergenceBps: state.maxDivergenceBps }
      : { maxAge: DEFAULT_MAX_PRICE_AGE_SECS, maxConfBps: DEFAULT_MAX_CONF_BPS, maxDivergenceBps: DEFAULT_MAX_DIVERGENCE_BPS },
    verdict: result,
    notes: result.notes,
    registryPaused: result.registryPaused,
  });
}

/** jup.ag price v3, as scripts/measure-basis.py reads it: the price the token trades at on chain. */
async function readMarketPrices(mints: readonly string[]): Promise<Map<string, number | null>> {
  const response = await fetch(`${JUPITER_PRICE_V3}?ids=${mints.join(',')}`, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`jup.ag price v3 answered HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, { usdPrice?: unknown } | null | undefined>;
  return new Map(
    mints.map((mint) => {
      const usd = body[mint]?.usdPrice;
      return [mint, typeof usd === 'number' && Number.isFinite(usd) && usd > 0 ? usd : null];
    }),
  );
}

async function readBasis(): Promise<BasisView> {
  const d = deliverable();
  const [accounts, labels, market] = await Promise.all([
    d.rpc.getMultipleAccounts([SCOPE_PRICES_ADDRESS, CLOCK_SYSVAR], { encoding: 'base64' }).send(),
    d.scopeLabels().catch((): ScopeLabel[] => []),
    settle(readMarketPrices(BASIS_FEEDS.map((f) => f.mint))),
  ]);

  const [scopeAccount, clockAccount] = accounts.value;
  if (!scopeAccount) throw new SourceUnavailable('The Scope OraclePrices account was not returned by the RPC.');
  if (scopeAccount.owner !== SCOPE_PROGRAM_ADDRESS) throw new SourceUnavailable('The Scope OraclePrices account is not owned by Scope.');
  if (!clockAccount) throw new SourceUnavailable('The Clock sysvar was not returned by the RPC.');

  const scope = Buffer.from(scopeAccount.data[0], 'base64');
  const now = Number(Buffer.from(clockAccount.data[0], 'base64').readBigInt64LE(CLOCK_UNIX_TIMESTAMP_OFFSET));
  const names = labelMap(labels);

  const rows: BasisRow[] = BASIS_FEEDS.map((feed) => {
    const observation = decodeScopeEntry(scope, feed.index);
    const oraclePrice = observationToNumber(observation);
    const oracleTs = Number(observation.publishTs);
    const oracleSlot = Number(scope.readBigUInt64LE(SCOPE_PRICES_OFFSET + feed.index * SCOPE_ENTRY_SIZE + SCOPE_SLOT_OFFSET));
    const marketPrice = market.ok ? (market.value.get(feed.mint) ?? null) : null;
    return {
      symbol: feed.symbol,
      mint: feed.mint,
      scopeIndex: feed.index,
      scopeLabel: names.get(feed.index) ?? null,
      oraclePrice,
      oracleTs,
      oracleSlot,
      reportedAge: now - oracleTs,
      marketPrice,
      basisBps: marketPrice === null ? null : ((marketPrice - oraclePrice) / oraclePrice) * 10_000,
    };
  });

  return {
    source: 'live',
    at: now,
    slot: Number(accounts.context.slot),
    session: resolveSession(US_EQUITY_CALENDAR, now),
    lastClose: lastClose(US_EQUITY_CALENDAR, now),
    rows,
    market: { ok: market.ok, error: market.ok ? null : market.error, source: 'jup.ag price v3' },
    gapSeconds: null,
    record: null,
  };
}

async function buildRail(mode: 'live' | 'preview'): Promise<RailSnapshot> {
  const [gates, basis] = await Promise.all([
    Promise.all(
      SECURITIES.map(async (security) => ({
        symbol: security.symbol,
        mint: security.mint,
        result: await settle(readGate(security, mode)),
      })),
    ),
    settle(readBasis()),
  ]);
  return { mode, readAt: Date.now(), gates, basis };
}

// Every viewer polls; one read per mode per ten seconds is shared between them so the
// RPC sees a bounded load however many people are looking.
const RAIL_TTL_MS = 10_000;
const memo = new Map<string, { at: number; value: Promise<RailSnapshot> }>();

export function readRail(mode: 'live' | 'preview'): Promise<RailSnapshot> {
  const hit = memo.get(mode);
  if (hit && Date.now() - hit.at < RAIL_TTL_MS) return hit.value;
  const value = buildRail(mode);
  memo.set(mode, { at: Date.now(), value });
  return value;
}
