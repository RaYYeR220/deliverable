/**
 * verify-onchain: check the headline claims against Solana mainnet, now.
 *
 *   cd scripts && pnpm install && pnpm verify
 *   pnpm verify -- --gap 90          # seconds between the two oracle samples (default 60)
 *
 * Every check prints PASS, FAIL or SKIP with the evidence it read. The exit code is 1 only
 * when a check FAILs, meaning the chain contradicts a claim. An endpoint that cannot be
 * reached is a SKIP with the reason, never a PASS.
 *
 * Environment, first match wins: the process environment, then the repo `.env`.
 *   SOLANA_RPC_URL           mainnet RPC. Falls back to the public endpoint, which works
 *                            but rate-limits. Only the host is ever printed.
 *   DELIVERABLE_PROGRAM_ID   check 9 only: the deployed program id
 *   DELIVERABLE_CLUSTER      check 9 only: devnet | mainnet-beta | testnet
 *   DEVNET_RPC_URL           check 9 only, optional: devnet RPC
 *
 * The market session is decided exactly as the program decides it: the exception table is
 * parsed out of programs/deliverable/src/state/registry.rs and resolved with the SDK's port
 * of calendar.rs (sdk/src/calendar.ts, which is tested case-for-case against the Rust).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  civilFromUnix,
  nextOpen,
  REGULAR_CLOSE_MINUTE,
  REGULAR_OPEN_MINUTE,
  resolveSession,
  US_EQUITY_2026_2027,
  type CalendarEntryLike,
  type CalendarLike,
} from '../sdk/src/calendar.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------------------
// Addresses. Every one of them is stated in README.md, MOCKS.md or the keeper history.
// ---------------------------------------------------------------------------------------

const SCOPE_PRICES = '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH';
const SCOPE_PROGRAM = 'HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ';
const CLOCK_SYSVAR = 'SysvarC1ock11111111111111111111111111111111';
const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const KLEND_PROGRAM = 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD';
const KAMINO_MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const MULTIPLIER_AUTHORITY = 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS';

const AAPLX = 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const NFLXX = 'XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL';
const CRWDX = 'Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw';

/** Scope entries Kamino's AAPLx and NVDAx reserves price from (README, MOCKS). */
const FEEDS = [
  { symbol: 'AAPLx', mint: AAPLX, index: 317 },
  { symbol: 'NVDAx', mint: NVDAX, index: 332 },
] as const;

/** Unit witness for the basis check: SPYx, Scope entry 342 (scripts/measure-basis.py). */
const WITNESS = { symbol: 'SPYx', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', index: 342 } as const;

/** The pinned transaction whose meta under-reports the balance (sdk/README.md). */
const PINNED_TX = '4rsX6HjrGb7i4WsG6yTVxnUZY1hyo3SLj3j2XbLXvid9Cn8s8tzk7SSEtra1yRrmvuxabtuaqZKkfaQynSJ6DCY';
const PINNED_TOKEN_ACCOUNT = 'EQYSiL5i4LdYLEyYs7F9faWJpd7SzNQK49SxXjAPoWLD';

/** Corporate-action transactions checked individually, by symbol, from the keeper history. */
const NAMED_ACTIONS = ['NVDAx', 'METAx', 'QQQx', 'AAPLx', 'CRWDx', 'NFLXx'] as const;

/** README: "$22.8M of tokenized-equity collateral", read 2026-09-22. */
const README_KAMINO_XSTOCKS_USD = 22.8e6;

/** app/src/lib/server/ledger.ts HACKATHON_WINDOW. */
const WINDOW = { from: Date.UTC(2026, 8, 11) / 1000, to: Date.UTC(2026, 8, 25, 20) / 1000 };

// ---------------------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------------------

function dotEnv(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(resolve(REPO, '.env'), 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const DOTENV = dotEnv();
const setting = (name: string): { value: string; from: string } | null => {
  const env = process.env[name]?.trim();
  if (env) return { value: env, from: 'environment' };
  const file = DOTENV[name]?.trim();
  if (file) return { value: file, from: 'repo .env' };
  return null;
};

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable url>';
  }
}

const rpcSetting = setting('SOLANA_RPC_URL');
const RPC_URL = rpcSetting?.value ?? 'https://api.mainnet-beta.solana.com';
const RPC_FROM = rpcSetting ? `SOLANA_RPC_URL from ${rpcSetting.from}` : 'public endpoint, SOLANA_RPC_URL unset';

function argNumber(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  const v = Number(process.argv[i + 1]);
  if (!Number.isFinite(v) || v < 5 || v > 900) throw new Error(`${flag} takes a number of seconds between 5 and 900`);
  return v;
}
const GAP_SECONDS = argNumber('--gap', 60);

// ---------------------------------------------------------------------------------------
// Transport. Errors never carry the URL, because the URL carries the key.
// ---------------------------------------------------------------------------------------

class ReadError extends Error {}

function scrub(message: string, url: string): string {
  return url ? message.split(url).join(hostOf(url)) : message;
}

async function rpcAt<T>(url: string, method: string, params: unknown[]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new ReadError(`${method} on ${hostOf(url)}: ${scrub(e instanceof Error ? e.message : String(e), url)}`);
    }
    if (res.status === 429 && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) throw new ReadError(`${method} on ${hostOf(url)}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { code: number; message: string } };
    if (body.error) throw new ReadError(`${method} on ${hostOf(url)}: ${scrub(body.error.message, url)}`);
    return body.result as T;
  }
}
const rpc = <T>(method: string, params: unknown[]) => rpcAt<T>(RPC_URL, method, params);

async function getJson<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'deliverable/verify-onchain' }, signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new ReadError(`${hostOf(url)}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new ReadError(`${hostOf(url)}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)));

type RawAccount = { data: [string, string]; owner: string; executable: boolean; lamports: number } | null;
type ParsedAccount = {
  data: { parsed?: { type: string; info: Record<string, unknown> }; program?: string } | [string, string];
  owner: string;
} | null;

async function rawAccounts(keys: string[], url = RPC_URL): Promise<{ slot: number; accounts: RawAccount[] }> {
  const r = await rpcAt<{ context: { slot: number }; value: RawAccount[] }>(url, 'getMultipleAccounts', [
    keys,
    { encoding: 'base64', commitment: 'confirmed' },
  ]);
  return { slot: r.context.slot, accounts: r.value };
}

async function parsedAccounts(keys: string[]): Promise<ParsedAccount[]> {
  const out: ParsedAccount[] = [];
  for (let i = 0; i < keys.length; i += 100) {
    const r = await rpc<{ value: ParsedAccount[] }>('getMultipleAccounts', [
      keys.slice(i, i + 100),
      { encoding: 'jsonParsed', commitment: 'confirmed' },
    ]);
    out.push(...r.value);
  }
  return out;
}

const bytesOf = (a: NonNullable<RawAccount>) => Buffer.from(a.data[0], 'base64');

// ---------------------------------------------------------------------------------------
// Base58
// ---------------------------------------------------------------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function b58decode(s: string): Buffer {
  let n = 0n;
  for (const c of s) {
    const v = B58.indexOf(c);
    if (v < 0) throw new Error(`not base58: ${c}`);
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) {
    bytes.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  for (const c of s) {
    if (c !== '1') break;
    bytes.unshift(0);
  }
  return Buffer.from(bytes);
}

function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
function utc(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`;
}
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function eastern(ts: number): string {
  const [y, m, d, minute] = civilFromUnix(ts);
  const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${wd} ${y}-${pad(m)}-${pad(d)} ${pad(Math.floor(minute / 60))}:${pad(minute % 60)} ET`;
}
const short = (s: string) => `${s.slice(0, 8)}...${s.slice(-4)}`;
const signed = (n: number, digits: number) => (n > 0 ? '+' : n < 0 ? '-' : '') + Math.abs(n).toFixed(digits);
const hours = (s: number) => `${(s / 3600).toFixed(1)} h`;
const usd = (n: number) => `$${(n / 1e6).toFixed(2)}M`;

/** Integer raw amount shifted `decimals` places, trailing zeros trimmed, as the RPC prints it. */
function rawToUi(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, '0');
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole;
}
/** The scaled UI string the token program derives: trunc(raw x multiplier) in raw units, then shifted. */
const scaledUi = (raw: bigint, multiplier: number, decimals: number) => rawToUi(BigInt(Math.trunc(Number(raw) * multiplier)), decimals);

// ---------------------------------------------------------------------------------------
// The calendar, as the program commits it
// ---------------------------------------------------------------------------------------

function programCalendar(): { cal: CalendarLike; entries: CalendarEntryLike[]; matchesSdk: boolean } {
  const src = readFileSync(resolve(REPO, 'programs/deliverable/src/state/registry.rs'), 'utf8');
  const block = /pub const US_EQUITY_2026_2027:[^=]*=\s*\[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error('US_EQUITY_2026_2027 not found in registry.rs');
  const entries: CalendarEntryLike[] = [];
  for (const line of block[1].split('\n')) {
    const code = line.replace(/\/\/.*$/, '');
    const c = /closed\(\s*(\d+)\s*,\s*(\d+)\s*\)/.exec(code);
    const e = /early\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\*\s*60(?:\s*\+\s*(\d+))?\s*\)/.exec(code);
    if (c) entries.push({ dateKey: (Number(c[1]) << 8) | Number(c[2]), kind: 0, closeMinute: 0 });
    else if (e) entries.push({ dateKey: (Number(e[1]) << 8) | Number(e[2]), kind: 1, closeMinute: Number(e[3]) * 60 + Number(e[4] ?? 0) });
  }
  const same = (a: CalendarEntryLike, b: CalendarEntryLike) => a.dateKey === b.dateKey && a.kind === b.kind && a.closeMinute === b.closeMinute;
  const matchesSdk = entries.length === US_EQUITY_2026_2027.length && entries.every((x, i) => same(x, US_EQUITY_2026_2027[i]));
  return {
    cal: { regularOpenMinute: REGULAR_OPEN_MINUTE, regularCloseMinute: REGULAR_CLOSE_MINUTE, entries },
    entries,
    matchesSdk,
  };
}

const CALENDAR = programCalendar();
const CAL = CALENDAR.cal;

/** The instant the current regular session closes (scans forward a minute at a time). */
function sessionCloseAfter(ts: number): number {
  let t = ts - (ts % 60);
  for (let i = 0; i < 24 * 60; i++, t += 60) if (resolveSession(CAL, t) === 'Closed') return t;
  return t;
}
/** The instant the most recent regular session ended (scans back a minute at a time). */
function lastCloseBefore(ts: number): number | null {
  let t = ts - (ts % 60);
  for (let i = 0; i < 20 * 24 * 60; i++, t -= 60) if (resolveSession(CAL, t - 60) === 'Regular') return t;
  return null;
}

// ---------------------------------------------------------------------------------------
// Decoders
// ---------------------------------------------------------------------------------------

interface ScopeEntry {
  value: bigint;
  exp: bigint;
  slot: bigint;
  ts: number;
  price: number;
}
function scopeEntry(data: Buffer, index: number): ScopeEntry {
  const o = 40 + index * 56;
  const value = data.readBigUInt64LE(o);
  const exp = data.readBigUInt64LE(o + 8);
  const slot = data.readBigUInt64LE(o + 16);
  const ts = Number(data.readBigUInt64LE(o + 24));
  return { value, exp, slot, ts, price: Number(value) / 10 ** Number(exp) };
}

interface ScopeSample {
  slot: number;
  clock: number;
  entries: Map<number, ScopeEntry>;
}
async function sampleScope(): Promise<ScopeSample> {
  const { slot, accounts } = await rawAccounts([SCOPE_PRICES, CLOCK_SYSVAR]);
  const [scope, clock] = accounts;
  if (!scope) throw new ReadError(`Scope OraclePrices ${SCOPE_PRICES} not found`);
  if (scope.owner !== SCOPE_PROGRAM) throw new ReadError(`Scope OraclePrices owner is ${scope.owner}, expected ${SCOPE_PROGRAM}`);
  if (!clock) throw new ReadError('Clock sysvar not returned');
  const data = bytesOf(scope);
  const entries = new Map<number, ScopeEntry>();
  for (const f of [...FEEDS, WITNESS]) entries.set(f.index, scopeEntry(data, f.index));
  return { slot, clock: Number(bytesOf(clock).readBigInt64LE(32)), entries };
}

interface ScaledUi {
  authority: string | null;
  multiplier: number;
  newMultiplier: number;
  effectiveTs: number;
}
interface MintView {
  scaled: ScaledUi | null;
  hook: { authority: string | null; programId: string | null } | null;
  paused: boolean | null;
  decimals: number;
  symbol: string | null;
}
function mintView(account: ParsedAccount): MintView | null {
  if (!account || Array.isArray(account.data) || account.data.parsed?.type !== 'mint') return null;
  const info = account.data.parsed.info as { decimals: number; extensions?: Array<{ extension: string; state: Record<string, unknown> }> };
  const ext = (name: string) => info.extensions?.find((e) => e.extension === name)?.state;
  const s = ext('scaledUiAmountConfig');
  const h = ext('transferHook');
  const p = ext('pausableConfig');
  const md = ext('tokenMetadata');
  return {
    decimals: info.decimals,
    scaled: s
      ? {
          authority: (s['authority'] as string | null) ?? null,
          multiplier: Number(s['multiplier']),
          newMultiplier: Number(s['newMultiplier']),
          effectiveTs: Number(s['newMultiplierEffectiveTimestamp']),
        }
      : null,
    hook: h ? { authority: (h['authority'] as string | null) ?? null, programId: (h['programId'] as string | null) ?? null } : null,
    paused: p ? Boolean(p['paused']) : null,
    symbol: md ? String(md['symbol']) : null,
  };
}
const effectiveAt = (s: ScaledUi, at: number) => (at >= s.effectiveTs ? s.newMultiplier : s.multiplier);

// ---------------------------------------------------------------------------------------
// The keeper history
// ---------------------------------------------------------------------------------------

interface Action {
  mint: string;
  symbol: string;
  signature: string;
  blockTime: number;
  slot: number;
  newMultiplier: number;
  effectiveTimestamp: number;
  previousMultiplier: number;
  previousEffectiveTimestamp?: number;
  classification: string;
}
const HISTORY_FILE = 'keeper/data/corporate-actions.json';
const HISTORY = JSON.parse(readFileSync(resolve(REPO, HISTORY_FILE), 'utf8')) as Action[];
const latestAction = (mint: string) =>
  HISTORY.filter((a) => a.mint === mint).sort((a, b) => b.effectiveTimestamp - a.effectiveTimestamp)[0];

// ---------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------

type Status = 'PASS' | 'FAIL' | 'SKIP';
interface Result {
  n: number;
  title: string;
  source: string;
  status: Status;
  lines: string[];
  verdict: string;
}

async function guarded(n: number, title: string, source: string, run: (r: Result) => Promise<void>): Promise<Result> {
  const r: Result = { n, title, source, status: 'SKIP', lines: [], verdict: '' };
  try {
    await run(r);
  } catch (e) {
    r.status = 'SKIP';
    r.verdict = `could not read: ${e instanceof Error ? scrub(e.message, RPC_URL) : String(e)}`;
  }
  return r;
}

function print(r: Result) {
  console.log(`\n[${r.n}] ${r.status}  ${r.title}`);
  console.log(`    claim     ${r.source}`);
  for (const l of r.lines) console.log(`    ${l}`);
  console.log(`    verdict   ${r.verdict}`);
}

// ---------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------

function checkFreeze(r: Result, a: ScopeSample, b: ScopeSample) {
  const s0 = resolveSession(CAL, a.clock);
  const s1 = resolveSession(CAL, b.clock);
  r.lines.push(`read      Scope ${SCOPE_PRICES} at slot ${a.slot} and again at slot ${b.slot}`);
  r.lines.push(`clock     ${utc(a.clock)} -> ${utc(b.clock)} (${b.clock - a.clock} s apart, Clock sysvar)`);
  r.lines.push(`session   ${s0} -> ${s1}  (committed calendar, programs/deliverable/src/state/registry.rs)`);

  const rows = FEEDS.map((f) => {
    const x = a.entries.get(f.index)!;
    const y = b.entries.get(f.index)!;
    const unchanged = x.value === y.value && x.exp === y.exp;
    // Exact when both samples share an exponent, so a move of one raw unit is never printed as 0.
    const delta = y.value - x.value;
    const moved =
      x.exp === y.exp
        ? `${delta > 0n ? '+' : '-'}${rawToUi(delta < 0n ? -delta : delta, Number(x.exp))}`
        : signed(y.price - x.price, 8);
    const tsAdvanced = y.ts - x.ts;
    const slotAdvanced = Number(y.slot - x.slot);
    r.lines.push(
      `${f.symbol.padEnd(6)} #${f.index}  price ${x.price.toFixed(4)} -> ${y.price.toFixed(4)}  moved ${unchanged ? '0 (identical raw value)' : moved}` +
        `  ts ${signed(tsAdvanced, 0)} s  slot ${signed(slotAdvanced, 0)}  age at 2nd read ${b.clock - y.ts} s`,
    );
    return { f, unchanged, tsAdvanced };
  });

  if (s0 !== s1) {
    r.status = 'SKIP';
    r.verdict = `the session changed between the samples (${s0} -> ${s1}); rerun and the check will apply one rule or the other`;
    return;
  }

  if (s0 === 'Closed') {
    const close = lastCloseBefore(b.clock);
    const open = nextOpen(CAL, b.clock, 20);
    if (close !== null) r.lines.push(`market    closed since ${utc(close)} (${hours(b.clock - close)} ago); next open ${open ? utc(open) : 'beyond the committed calendar'}`);
    const bad = rows.filter((x) => !x.unchanged || x.tsAdvanced <= 0);
    if (bad.length === 0) {
      r.status = 'PASS';
      r.verdict =
        `market closed: the timestamps advanced and the prices did not move. A freshness check passes on a price that is ` +
        (close !== null ? `${hours(b.clock - close)} old economically.` : 'economically stale.');
    } else {
      r.status = 'FAIL';
      r.verdict = bad
        .map((x) => (!x.unchanged ? `${x.f.symbol} moved while the market is closed` : `${x.f.symbol} timestamp did not advance`))
        .join('; ') + ' - the freeze claim does not hold for this read.';
    }
    return;
  }

  const close = sessionCloseAfter(b.clock);
  r.lines.push(`market    regular session in progress; it closes ${utc(close)} (${eastern(close)})`);
  const movedAll = rows.every((x) => !x.unchanged);
  const liveAll = rows.every((x) => x.tsAdvanced > 0);
  if (movedAll && liveAll) {
    r.status = 'PASS';
    r.verdict =
      'regular session: the feed tracks, as it should. The claim is that it freezes while the reference market is closed, ' +
      `which cannot be observed now. Rerun after ${utc(close)} to see the freeze.`;
  } else {
    r.status = 'SKIP';
    r.verdict =
      `regular session: ${rows.filter((x) => x.unchanged).map((x) => x.f.symbol).join(', ') || 'no entry'} did not move in ${b.clock - a.clock} s. ` +
      `Not evidence either way; the freeze claim applies only while the market is closed. Rerun with a longer --gap or after ${utc(close)}.`;
  }
}

/**
 * Units. Jupiter's `usdPrice` is per scaled UI unit (one share). A Scope xStock entry is per
 * unscaled token, raw / 10^decimals, which is worth `multiplier` shares: that is the unit a
 * lending market multiplying raw collateral by the price needs. Like for like, the oracle's
 * price per share is `scope / multiplier`, and the basis is
 * (usdPrice - oracle per share) / oracle per share, as README.md and scripts/measure-basis.py
 * compute it. The bare figure, usdPrice against the per-token oracle, is how the first version
 * of the README tables was computed; it is off by the multiplier and is printed beside the
 * like-for-like figure so the difference stays visible. SPYx carries the largest multiplier of
 * the entries measured, so it is printed as a witness: whichever of its two gaps sits near zero
 * inside a session shows the unit Scope uses.
 */
async function checkBasis(r: Result, b: ScopeSample, mints: Map<string, MintView | null>) {
  const rows = [...FEEDS, WITNESS];
  const ids = rows.map((f) => f.mint).join(',');
  const jup = await getJson<Record<string, { usdPrice?: number; blockId?: number } | undefined>>(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
  const session = resolveSession(CAL, b.clock);
  r.lines.push(`read      Scope at slot ${b.slot}; lite-api.jup.ag/price/v3 immediately after; multiplier from each mint`);
  const parts: string[] = [];
  for (const f of rows) {
    const o = b.entries.get(f.index)!;
    const d = jup[f.mint]?.usdPrice;
    const s = mints.get(f.mint)?.scaled;
    if (typeof d !== 'number' || !s) {
      r.lines.push(`${f.symbol.padEnd(6)} oracle ${o.price.toFixed(4)}  on-chain market or multiplier not returned`);
      continue;
    }
    const m = effectiveAt(s, b.clock);
    const perShare = o.price / m;
    const like = ((d - perShare) / perShare) * 1e4;
    const bare = ((d - o.price) / o.price) * 1e4;
    if (f !== WITNESS) parts.push(`${f.symbol} ${signed(like, 1)} bps`);
    r.lines.push(
      `${(f === WITNESS ? `${f.symbol}*` : f.symbol).padEnd(6)} oracle ${o.price.toFixed(4)} / m ${m} = ${perShare.toFixed(4)} per share  usdPrice ${d.toFixed(4)}  ` +
        `basis ${signed(like, 1)} bps like-for-like (${signed(bare, 1)} bps bare, per token against per share)`,
    );
  }
  if (parts.length === 0) throw new ReadError('Jupiter price v3 returned no price for AAPLx or NVDAx');
  r.lines.push(`          * SPYx is the unit witness (largest multiplier): the gap near zero is the matching unit`);
  r.lines.push('pinned    README, 2026-09-20 09:15 UTC, like-for-like: AAPLx -69.0, NVDAx -60.3 bps (bare, as first published: -101.3, -77.2)');
  r.status = 'PASS';
  r.verdict =
    session === 'Closed'
      ? `measured with the market closed: ${parts.join(', ')} like-for-like. The oracle holds the last regular-session print while the token keeps trading; the gap drifts. This check measures, it asserts no threshold.`
      : `measured inside a regular session: ${parts.join(', ')} like-for-like. The headline figures were taken while closed. This check measures, it asserts no threshold.`;
}

async function checkMultiplier(r: Result, mints: Map<string, MintView | null>, clock: number) {
  let ok = true;
  for (const f of FEEDS) {
    const m = mints.get(f.mint);
    const s = m?.scaled;
    if (!m || !s) {
      ok = false;
      r.lines.push(`${f.symbol.padEnd(6)} ${f.mint}: ScaledUiAmount extension NOT present`);
      continue;
    }
    const last = latestAction(f.mint);
    r.lines.push(
      `${f.symbol.padEnd(6)} ${f.mint}  ScaledUiAmount present, authority ${s.authority ?? 'none'}` +
        (s.authority === MULTIPLIER_AUTHORITY ? ' (the shared xStocks authority)' : ''),
    );
    r.lines.push(`          multiplier ${s.multiplier} -> newMultiplier ${s.newMultiplier} effective ${utc(s.effectiveTs)}; in force now ${effectiveAt(s, clock)}${clock < s.effectiveTs ? ' (change PENDING)' : ''}`);
    if (!last) {
      r.lines.push(`          no action for this mint in ${HISTORY_FILE}`);
      continue;
    }
    r.lines.push(`          ${HISTORY_FILE}: last recovered action sets ${last.newMultiplier} effective ${utc(last.effectiveTimestamp)} (${short(last.signature)})`);
    if (s.effectiveTs === last.effectiveTimestamp) {
      if (s.newMultiplier !== last.newMultiplier) {
        ok = false;
        r.lines.push(`          MISMATCH: same effective time, different multiplier`);
      }
    } else if (s.effectiveTs > last.effectiveTimestamp) {
      r.lines.push(`          the mint carries a newer action than the history file; rerun \`pnpm history\` in keeper/ to record it`);
    } else {
      ok = false;
      r.lines.push(`          MISMATCH: the history records a later action than the mint shows`);
    }
  }
  r.status = ok ? 'PASS' : 'FAIL';
  r.verdict = ok
    ? 'both mints carry ScaledUiAmount, and the multiplier matches the last UpdateMultiplier the keeper recovered for each (AAPLx 1.0032690125398187 is the value sdk/README.md states).'
    : 'the mint and the recorded history disagree; see above.';
}

async function checkSplits(r: Result, mints: Map<string, MintView | null>, clock: number) {
  const want = [
    { symbol: 'NFLXx', mint: NFLXX, factor: 10 },
    { symbol: 'CRWDx', mint: CRWDX, factor: 4 },
  ];
  let ok = true;
  for (const w of want) {
    const s = mints.get(w.mint)?.scaled;
    if (!s) {
      ok = false;
      r.lines.push(`${w.symbol.padEnd(6)} ${w.mint}: ScaledUiAmount extension NOT present`);
      continue;
    }
    const now = effectiveAt(s, clock);
    const rec = HISTORY.find((a) => a.mint === w.mint && a.classification === 'split');
    r.lines.push(
      `${w.symbol.padEnd(6)} ${w.mint}  multiplier ${s.multiplier} -> ${s.newMultiplier} effective ${utc(s.effectiveTs)}; in force now ${now}` +
        (rec ? `; split tx ${short(rec.signature)}` : ''),
    );
    if (now !== w.factor) ok = false;
  }
  r.status = ok ? 'PASS' : 'FAIL';
  r.verdict = ok ? 'NFLXx is at 10 and CRWDx at 4, and each mint still records the 1 -> N step it took.' : 'a mint is not at the stated split multiplier.';
}

interface TxJson {
  slot: number;
  blockTime: number | null;
  meta: {
    err: unknown;
    loadedAddresses?: { writable: string[]; readonly: string[] };
    innerInstructions?: Array<{ instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }> }>;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
  transaction: { message: { accountKeys: string[]; instructions: Array<{ programIdIndex: number; accounts: number[]; data: string }> } };
}
interface TokenBalance {
  accountIndex: number;
  mint: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null; uiAmountString: string };
}

const getTx = (sig: string) =>
  rpc<TxJson | null>('getTransaction', [sig, { encoding: 'json', maxSupportedTransactionVersion: 0, commitment: 'confirmed' }]);

function accountKeys(tx: TxJson): string[] {
  return [...tx.transaction.message.accountKeys, ...(tx.meta?.loadedAddresses?.writable ?? []), ...(tx.meta?.loadedAddresses?.readonly ?? [])];
}

async function checkActions(r: Result) {
  const inWindow = HISTORY.filter((a) => a.effectiveTimestamp >= WINDOW.from && a.effectiveTimestamp <= WINDOW.to);
  r.lines.push(
    `file      ${HISTORY_FILE}: ${HISTORY.length} actions across ${new Set(HISTORY.map((a) => a.mint)).size} mints; ` +
      `${inWindow.length} across ${new Set(inWindow.map((a) => a.mint)).size} mints effective 2026-09-11 to 2026-09-25`,
  );
  let ok = true;
  let checked = 0;
  for (const symbol of NAMED_ACTIONS) {
    const row = HISTORY.filter((a) => a.symbol === symbol).sort((a, b) => b.blockTime - a.blockTime)[0];
    if (!row) {
      ok = false;
      r.lines.push(`${symbol.padEnd(6)} no row in the history file`);
      continue;
    }
    const tx = await getTx(row.signature);
    if (!tx) {
      ok = false;
      r.lines.push(`${symbol.padEnd(6)} ${short(row.signature)}  NOT FOUND by getTransaction`);
      continue;
    }
    checked++;
    const keys = accountKeys(tx);
    const all = [
      ...tx.transaction.message.instructions,
      ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
    ];
    const updates = all
      .filter((ix) => keys[ix.programIdIndex] === TOKEN_2022)
      .map((ix) => ({ ix, data: b58decode(ix.data) }))
      .filter(({ data }) => data.length === 18 && data[0] === 0x2b && data[1] === 0x01)
      .map(({ ix, data }) => ({ mint: keys[ix.accounts[0]], multiplier: data.readDoubleLE(2), effective: Number(data.readBigInt64LE(10)) }));
    const match = updates.find((u) => u.mint === row.mint && u.multiplier === row.newMultiplier && u.effective === row.effectiveTimestamp);
    const status = tx.meta?.err ? 'FAILED TX' : 'succeeded';
    r.lines.push(
      `${symbol.padEnd(6)} ${short(row.signature)}  slot ${tx.slot}  ${tx.blockTime ? utc(tx.blockTime) : '?'}  ${status}  ` +
        `${updates.length} x 0x2B 0x01 -> ${updates.map((u) => `${u.multiplier} @ ${u.effective === 0 ? 'ts 0' : utc(u.effective).slice(0, 16)}`).join(', ')}`,
    );
    if (!match || tx.meta?.err || tx.slot !== row.slot) {
      ok = false;
      r.lines.push(`          does not match the file (mint ${short(row.mint)}, ${row.newMultiplier} effective ${utc(row.effectiveTimestamp)}, slot ${row.slot})`);
    }
  }
  r.status = ok ? 'PASS' : 'FAIL';
  r.verdict = ok
    ? `all ${checked} transactions exist, succeeded, and carry a Token-2022 UpdateMultiplier (0x2B 0x01 | f64 | i64) whose mint, multiplier and effective time match the file.`
    : 'a transaction is missing or does not carry the recorded UpdateMultiplier.';
}

async function checkHook(r: Result, mints: Map<string, MintView | null>) {
  let ok = true;
  for (const f of FEEDS) {
    const m = mints.get(f.mint);
    const h = m?.hook;
    r.lines.push(
      `${f.symbol.padEnd(6)} transferHook ${h ? `programId ${h.programId ?? 'null'}, authority ${h.authority ?? 'null'}` : 'extension NOT present'}; pausable ${m?.paused === null ? 'absent' : m?.paused ? 'PAUSED' : 'not paused'}`,
    );
    if (!h || h.programId !== null || h.authority === null) ok = false;
  }
  // The same read across every mint the keeper history names.
  const sweep = [...new Set(HISTORY.map((a) => a.mint))];
  const views = await parsedAccounts(sweep);
  let emptyLive = 0;
  const filled: string[] = [];
  const other: string[] = [];
  views.forEach((acc, i) => {
    const h = mintView(acc)?.hook;
    if (h && h.programId === null && h.authority !== null) emptyLive++;
    else if (h && h.programId !== null) filled.push(`${sweep[i]} -> ${h.programId}`);
    else other.push(sweep[i]);
  });
  r.lines.push(`sweep     ${sweep.length} mints in ${HISTORY_FILE}: ${emptyLive} empty hook with live authority, ${filled.length} with a hook program attached, ${other.length} other`);
  for (const f of filled) r.lines.push(`          hook attached: ${f}`);
  if (filled.length) ok = false;
  r.status = ok ? 'PASS' : 'FAIL';
  r.verdict = ok
    ? `AAPLx and NVDAx carry an initialised transfer hook with programId null and a live authority; so do ${emptyLive} of the ${sweep.length} mints swept.`
    : 'a transfer hook is attached, or the authority is gone; see above.';
}

async function checkRpcDisagreement(r: Result, mints: Map<string, MintView | null>) {
  const tx = await getTx(PINNED_TX);
  if (!tx || !tx.meta) throw new ReadError(`getTransaction returned nothing for ${short(PINNED_TX)}`);
  const keys = accountKeys(tx);
  const idx = keys.indexOf(PINNED_TOKEN_ACCOUNT);
  const bal = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])].find((b) => b.accountIndex === idx);
  if (!bal) throw new ReadError(`no token balance for ${PINNED_TOKEN_ACCOUNT} in the transaction meta`);
  const s = mints.get(bal.mint)?.scaled;
  if (!s || tx.blockTime === null) throw new ReadError('mint multiplier or block time unavailable');

  // The multiplier in force at the block time. The mint remembers only its latest change.
  let m: number | null = null;
  let provenance = '';
  if (tx.blockTime >= s.effectiveTs) {
    m = s.newMultiplier;
    provenance = `mint newMultiplier, in force since ${utc(s.effectiveTs)}`;
  } else {
    const prev = HISTORY.find((a) => a.mint === bal.mint && a.effectiveTimestamp === s.effectiveTs);
    if (prev?.previousEffectiveTimestamp !== undefined && tx.blockTime >= prev.previousEffectiveTimestamp) {
      m = s.multiplier;
      provenance = `mint multiplier, in force from ${utc(prev.previousEffectiveTimestamp)} (keeper history)`;
    }
  }
  if (m === null) throw new ReadError('the multiplier at the block time cannot be established from the mint and the history');

  const raw = BigInt(bal.uiTokenAmount.amount);
  const d = bal.uiTokenAmount.decimals;
  const unscaled = rawToUi(raw, d);
  const corrected = (Number(raw) / 10 ** d) * m;
  r.lines.push(`tx        ${short(PINNED_TX)}  slot ${tx.slot}  ${utc(tx.blockTime)}  token account ${short(PINNED_TOKEN_ACCOUNT)} (${bal.mint === AAPLX ? 'AAPLx' : bal.mint})`);
  r.lines.push(`meta      amount ${bal.uiTokenAmount.amount}, uiAmountString ${bal.uiTokenAmount.uiAmountString}  (raw / 10^${d} = ${unscaled})`);
  const correctedUi = scaledUi(raw, m, d);
  r.lines.push(`correct   ${bal.uiTokenAmount.amount} / 10^${d} x ${m} = ${corrected}  -> ${correctedUi}  [${provenance}]`);
  const metaUnscaled = bal.uiTokenAmount.uiAmountString === unscaled;
  const metaWrong = bal.uiTokenAmount.uiAmountString !== correctedUi;

  // The paths that do apply it, read now.
  const nowM = effectiveAt(s, Math.floor(Date.now() / 1000));
  const supply = await rpc<{ value: { amount: string; decimals: number; uiAmountString: string } }>('getTokenSupply', [bal.mint]);
  const supplyRaw = BigInt(supply.value.amount);
  const supplyScaled = scaledUi(supplyRaw, nowM, supply.value.decimals);
  const supplyUnscaled = rawToUi(supplyRaw, supply.value.decimals);
  const supplyApplies = supply.value.uiAmountString === supplyScaled && supplyScaled !== supplyUnscaled;
  r.lines.push(`supply    getTokenSupply now: amount ${supply.value.amount}, uiAmountString ${supply.value.uiAmountString}; x ${nowM} gives ${supplyScaled}, unscaled ${supplyUnscaled}`);
  let accountLine = '';
  try {
    const acc = await rpc<{ value: { amount: string; decimals: number; uiAmountString: string } }>('getTokenAccountBalance', [PINNED_TOKEN_ACCOUNT]);
    const a = BigInt(acc.value.amount);
    const scaled = scaledUi(a, nowM, acc.value.decimals);
    accountLine = `getTokenAccountBalance now: amount ${acc.value.amount}, uiAmountString ${acc.value.uiAmountString}; ${acc.value.uiAmountString === scaled && a > 0n ? 'scaled' : a === 0n ? 'empty account, nothing to compare' : 'NOT scaled'}`;
  } catch (e) {
    accountLine = `getTokenAccountBalance: ${e instanceof Error ? e.message : String(e)}`;
  }
  r.lines.push(`account   ${accountLine}`);

  if (metaUnscaled && metaWrong && supplyApplies) {
    r.status = 'PASS';
    r.verdict = `getTransaction meta reports ${bal.uiTokenAmount.uiAmountString}, the raw amount with no multiplier; the multiplier-correct figure is ${correctedUi}. getTokenSupply applies the multiplier. The RPC disagrees with itself.`;
  } else {
    r.status = 'FAIL';
    r.verdict = !metaUnscaled || !metaWrong
      ? 'the transaction meta now applies the multiplier; the disagreement claim no longer holds.'
      : 'getTokenSupply did not apply the multiplier; the claim about which paths scale does not hold.';
  }
}

async function checkKamino(r: Result) {
  type Row = { reserve: string; liquidityToken: string; liquidityTokenMint: string; totalSupplyUsd: string };
  const url = `https://api.kamino.finance/kamino-market/${KAMINO_MARKET}/reserves/metrics?env=mainnet-beta`;
  const rows = await getJson<Row[]>(url);
  const xs = rows.filter((x) => x.liquidityTokenMint.startsWith('Xs'));
  const total = xs.reduce((s, x) => s + Number(x.totalSupplyUsd), 0);
  const drift = ((total - README_KAMINO_XSTOCKS_USD) / README_KAMINO_XSTOCKS_USD) * 100;
  r.lines.push(`api       api.kamino.finance .../kamino-market/${short(KAMINO_MARKET)}/reserves/metrics: ${rows.length} reserves, ${xs.length} of them xStocks (mint prefix Xs)`);
  r.lines.push(`supply    xStocks totalSupplyUsd now ${usd(total)}; README states $22.8M read 2026-09-22 (drift ${signed(drift, 1)}%)`);
  r.lines.push(`          ${xs.map((x) => `${x.liquidityToken} ${usd(Number(x.totalSupplyUsd))}`).join(', ')}`);

  // Which Scope entry each reserve prices from: TokenInfo.scope_configuration is
  // { price_feed: Pubkey, price_chain: [u16; 4], twap_chain: [u16; 4] }, so the chain is the
  // eight bytes after the OraclePrices key inside the reserve account.
  const want = FEEDS.map((f) => ({ ...f, reserve: rows.find((x) => x.liquidityTokenMint === f.mint)?.reserve }));
  const missing = want.filter((w) => !w.reserve);
  if (missing.length) throw new ReadError(`no reserve for ${missing.map((m) => m.symbol).join(', ')} in the metrics response`);
  const { accounts } = await rawAccounts(want.map((w) => w.reserve!));
  const scopeKey = b58decode(SCOPE_PRICES);
  const marketKey = b58decode(KAMINO_MARKET);
  let ok = true;
  want.forEach((w, i) => {
    const acc = accounts[i];
    if (!acc) {
      ok = false;
      r.lines.push(`${w.symbol.padEnd(6)} reserve ${w.reserve} not found`);
      return;
    }
    const data = bytesOf(acc);
    const at = data.indexOf(scopeKey);
    const chain = at >= 0 ? [0, 1, 2, 3].map((j) => data.readUInt16LE(at + 32 + j * 2)).filter((v) => v !== 0xffff) : [];
    const inMarket = data.indexOf(marketKey) >= 0;
    r.lines.push(
      `${w.symbol.padEnd(6)} reserve ${w.reserve}  owner ${acc.owner === KLEND_PROGRAM ? 'klend' : acc.owner}  market ${inMarket ? 'matches' : 'NOT referenced'}  ` +
        (at >= 0 ? `Scope feed ${short(SCOPE_PRICES)} at byte ${at}, price chain [${chain.join(', ')}]` : 'Scope OraclePrices NOT referenced'),
    );
    if (acc.owner !== KLEND_PROGRAM || !inMarket || chain[0] !== w.index) ok = false;
  });
  r.status = ok ? 'PASS' : 'FAIL';
  r.verdict = ok
    ? `Kamino's AAPLx and NVDAx reserves price from Scope entries 317 and 332 of ${short(SCOPE_PRICES)}; xStocks supply in the market is ${usd(total)} now. The other ${xs.length - 2} xStocks reserves are not checked here.`
    : 'a reserve does not price from the stated Scope entry; see above.';
}

async function checkDeployment(r: Result) {
  const id = setting('DELIVERABLE_PROGRAM_ID');
  const cluster = setting('DELIVERABLE_CLUSTER');
  r.lines.push(`idl       the IDL declares DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa; that is not evidence of a deployment`);
  if (!id || !cluster) {
    r.status = 'SKIP';
    r.verdict =
      `${!id ? 'DELIVERABLE_PROGRAM_ID' : ''}${!id && !cluster ? ' and ' : ''}${!cluster ? 'DELIVERABLE_CLUSTER' : ''} not set, so there is no deployment to check. ` +
      'No deployment is recorded yet (PROOF.md, Deployments). Set both, e.g. DELIVERABLE_CLUSTER=devnet, to check one.';
    return;
  }
  const c = cluster.value;
  let url: string;
  if (c === 'mainnet-beta' || c === 'mainnet') url = RPC_URL;
  else if (c === 'devnet') {
    const explicit = setting('DEVNET_RPC_URL');
    if (explicit) url = explicit.value;
    else if (rpcSetting && hostOf(RPC_URL).includes('helius-rpc.com')) {
      const u = new URL(RPC_URL);
      u.host = u.host.replace(/^[^.]+/, 'devnet');
      url = u.toString();
    } else url = 'https://api.devnet.solana.com';
  } else if (c === 'testnet') url = 'https://api.testnet.solana.com';
  else throw new ReadError(`DELIVERABLE_CLUSTER must be devnet, mainnet-beta or testnet, not ${c}`);

  r.lines.push(`target    ${id.value} on ${c} (via ${hostOf(url)})`);
  const { slot, accounts } = await rawAccounts([id.value], url);
  const acc = accounts[0];
  if (!acc) {
    r.status = 'FAIL';
    r.verdict = `no account at ${id.value} on ${c} (slot ${slot}).`;
    return;
  }
  r.lines.push(`account   owner ${acc.owner}, executable ${acc.executable}, ${acc.lamports} lamports`);
  if (acc.owner === 'BPFLoaderUpgradeab1e11111111111111111111111') {
    const data = bytesOf(acc);
    const programData = b58encode(data.subarray(4, 36));
    const pd = (await rawAccounts([programData], url)).accounts[0];
    if (pd) {
      const b = bytesOf(pd);
      const deploySlot = b.readBigUInt64LE(4);
      const auth = b[12] === 1 ? b58encode(b.subarray(13, 45)) : 'none (immutable)';
      r.lines.push(`program   programdata ${programData}, last deployed at slot ${deploySlot}, upgrade authority ${auth}, ${b.length - 45} bytes`);
    }
  }
  r.status = acc.executable ? 'PASS' : 'FAIL';
  r.verdict = acc.executable ? `the program exists on ${c} and is executable.` : `the account exists on ${c} but is not executable.`;
}

async function checkCalendar(r: Result, clock: number) {
  r.lines.push(
    `program   ${CALENDAR.entries.length} exceptions parsed from programs/deliverable/src/state/registry.rs; ` +
      `${CALENDAR.matchesSdk ? 'identical to' : 'DIFFERENT FROM'} sdk/src/calendar.ts`,
  );
  type Feed = { market_hours?: { is_open: boolean }; attributes: { symbol: string; schedule?: string } };
  const feeds = await getJson<Feed[]>('https://hermes.pyth.network/v2/price_feeds?query=AAPL&asset_type=equity');
  const feed = feeds.find((f) => f.attributes.symbol === 'Equity.US.AAPL/USD');
  if (!feed?.attributes.schedule) throw new ReadError('Equity.US.AAPL/USD not in the Hermes response');
  const schedule = feed.attributes.schedule;
  r.lines.push(`publisher hermes.pyth.network Equity.US.AAPL/USD schedule: ${schedule}`);

  const [, weekly = '', holidays = ''] = schedule.split(';');
  const weekOk = weekly === '0930-1600,0930-1600,0930-1600,0930-1600,0930-1600,C,C';
  const committed = new Map(CALENDAR.entries.map((e) => [e.dateKey, e]));
  const extra: string[] = [];
  const differ: string[] = [];
  const seen = new Set<number>();
  for (const h of holidays.split(',').filter(Boolean)) {
    const [mmdd, rule] = h.split('/');
    const key = (Number(mmdd.slice(0, 2)) << 8) | Number(mmdd.slice(2));
    seen.add(key);
    const mine = committed.get(key);
    if (!mine) {
      extra.push(h);
      continue;
    }
    if (rule === 'C' ? mine.kind !== 0 : !(mine.kind === 1 && rule === `0930-${pad(Math.floor(mine.closeMinute / 60))}${pad(mine.closeMinute % 60)}`)) differ.push(h);
  }
  const retired = CALENDAR.entries.filter((e) => !seen.has(e.dateKey)).map((e) => `${pad(e.dateKey >> 8)}${pad(e.dateKey & 0xff)}`);
  const ours = resolveSession(CAL, clock);
  const theirs = feed.market_hours?.is_open;
  r.lines.push(`compare   weekly hours ${weekOk ? 'match' : 'DIFFER'}; publisher exceptions missing from the program: ${extra.length ? extra.join(', ') : 'none'}; rules that differ: ${differ.length ? differ.join(', ') : 'none'}${retired.length ? `; committed but no longer listed by the publisher: ${retired.join(', ')}` : ''}`);
  r.lines.push(`now       program session ${ours}; publisher says is_open ${theirs ?? 'unknown'}`);
  const ok = CALENDAR.matchesSdk && weekOk && extra.length === 0 && differ.length === 0;
  r.status = ok ? 'PASS' : 'FAIL';
  r.verdict = ok
    ? "the committed calendar is the price publisher's own schedule: same weekly hours, and every holiday and half-day the publisher lists is committed with the same rule."
    : 'the committed calendar and the publisher schedule disagree; see above.';
}

// ---------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------

async function main() {
  console.log('verify-onchain: Deliverable headline claims, checked against Solana mainnet now');
  console.log(`rpc host    ${hostOf(RPC_URL)}  (${RPC_FROM})`);

  const firstOrError = await sampleScope().then(
    (s) => ({ ok: true as const, s }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  // Without the first sample there is no chain clock; the wall clock stands in for the
  // checks that need a time, and checks 1 and 2 report SKIP with the read error.
  const clock = firstOrError.ok ? firstOrError.s.clock : Math.floor(Date.now() / 1000);
  const session = resolveSession(CAL, clock);
  if (firstOrError.ok) {
    console.log(`chain clock ${utc(clock)}  = ${eastern(clock)}  slot ${firstOrError.s.slot}`);
  } else {
    console.log(`chain clock unavailable (${firstOrError.e instanceof Error ? scrub(firstOrError.e.message, RPC_URL) : String(firstOrError.e)}); wall clock ${utc(clock)}`);
  }
  console.log(`session     ${session}  (US equity calendar, ${CALENDAR.entries.length} exceptions, the program's own rule)`);
  if (firstOrError.ok) console.error(`\n... first Scope sample taken; second in ${GAP_SECONDS} s. Running the other checks meanwhile.`);
  const due = firstOrError.ok ? Date.now() + GAP_SECONDS * 1000 : Date.now();

  const mintKeys = [AAPLX, NVDAX, NFLXX, CRWDX, WITNESS.mint];
  const mintAccounts = await parsedAccounts(mintKeys).catch(() => null);
  const mints = new Map<string, MintView | null>(mintKeys.map((k, i) => [k, mintAccounts ? mintView(mintAccounts[i]) : null]));
  const needMints = async () => {
    if (!mintAccounts) throw new ReadError('getMultipleAccounts (jsonParsed) failed for the xStock mints');
  };

  const results: Result[] = [];
  const later: Result[] = [];
  later.push(
    await guarded(3, 'The multiplier: AAPLx and NVDAx carry ScaledUiAmount at the recorded value', 'README "Meanwhile the unit itself moves"; MOCKS "The underlying"; sdk/README.md', async (r) => {
      await needMints();
      await checkMultiplier(r, mints, clock);
    }),
    await guarded(4, 'The splits happened on-chain: NFLXx at 10, CRWDx at 4', 'README "Netflix went ten-for-one on-chain as 1.0 -> 10.0. CrowdStrike ... 1.0 -> 4.0"', async (r) => {
      await needMints();
      await checkSplits(r, mints, clock);
    }),
    await guarded(5, 'The corporate-action transactions exist and carry UpdateMultiplier', `MOCKS "The corporate actions"; ${HISTORY_FILE}`, (r) => checkActions(r)),
    await guarded(6, 'Empty transfer hook, live authority', 'README "Every xStock carries an initialised-but-empty transfer hook whose authority is live"; MOCKS "Known upstream risks"', async (r) => {
      await needMints();
      await checkHook(r, mints);
    }),
    await guarded(7, 'The RPC disagrees with itself about the balance', 'README "getTransaction transaction meta does not [apply the multiplier]"; sdk/README.md', async (r) => {
      await needMints();
      await checkRpcDisagreement(r, mints);
    }),
    await guarded(8, "Kamino's xStocks collateral and the Scope entries it prices from", 'README "$22.8M ... its AAPLx and NVDAx reserves price from entries 317 and 332"', (r) => checkKamino(r)),
    await guarded(9, 'Program deployment', 'PROOF.md "Deployments"', (r) => checkDeployment(r)),
    await guarded(10, "The committed calendar is the price publisher's schedule", 'README "The calendar we commit is the price publisher\'s own published schedule"', (r) => checkCalendar(r, clock)),
  );

  await sleep(due - Date.now());
  const secondOrError = firstOrError.ok
    ? await sampleScope().then(
        (s) => ({ ok: true as const, s }),
        (e: unknown) => ({ ok: false as const, e }),
      )
    : firstOrError;
  results.push(
    await guarded(1, 'The oracle freeze: still while the market is closed, tracking while it is open', 'README "The problem, stated exactly"; MOCKS "The oracle"', async (r) => {
      if (!firstOrError.ok) throw firstOrError.e;
      if (!secondOrError.ok) throw secondOrError.e;
      checkFreeze(r, firstOrError.s, secondOrError.s);
    }),
    await guarded(2, 'The basis: oracle against the on-chain market price', 'README tables; scripts/measure-basis.py', async (r) => {
      if (!secondOrError.ok) throw secondOrError.e;
      await needMints();
      await checkBasis(r, secondOrError.s, mints);
    }),
    ...later,
  );

  for (const r of results) print(r);
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  console.log(`\n${results.length} checks: ${count('PASS')} PASS, ${count('FAIL')} FAIL, ${count('SKIP')} SKIP`);
  process.exitCode = count('FAIL') > 0 ? 1 : 0;
}

main().catch((e) => {
  console.error(e instanceof Error ? scrub(e.message, RPC_URL) : String(e));
  process.exitCode = 2;
});
