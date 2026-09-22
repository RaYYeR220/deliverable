// Shared plumbing for the devnet deployment scripts: configuration, PDAs,
// hand-encoded instructions for the handful of Deliverable instructions the
// deployment needs, account decoders, and a deployment record that every
// script appends to.
//
// Instructions are encoded by hand from the IDL (target/idl/deliverable.json)
// rather than through an Anchor client, so these scripts depend only on
// web3.js and the Pyth receiver SDK. Every discriminator below is copied from
// the IDL and checked against it at startup.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
  type Signer,
} from '@solana/web3.js';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '../..');
export const KEYS_DIR = join(HERE, 'keys');
export const DEPLOYMENT_FILE = join(HERE, 'deployment.json');

// --- configuration ---------------------------------------------------------

/** Load `KEY=VALUE` lines from the repo `.env` without overriding the shell. */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = raw.replace(/^['"]|['"]$/g, '');
  }
}
loadDotEnv(join(ROOT, '.env'));

/**
 * Devnet RPC. `DEVNET_RPC_URL` wins; otherwise Helius devnet with
 * `HELIUS_API_KEY`; otherwise the public endpoint, which rate-limits hard.
 */
export const RPC_URL: string =
  process.env.DEVNET_RPC_URL ??
  (process.env.HELIUS_API_KEY
    ? `https://devnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
    : 'https://api.devnet.solana.com');

/** The host only: RPC URLs carry API keys and are never printed whole. */
export function rpcHost(url: string = RPC_URL): string {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable>';
  }
}

export const HERMES_URL = 'https://hermes.pyth.network';
export const PYTH_API_KEY = process.env.PYTH_API_KEY;

export const PROGRAM_ID = new PublicKey(
  process.env.DELIVERABLE_PROGRAM_ID ?? 'DnLxRcayAcjUFFuLjobQmJ7K75EgDRGFkUj5tfWcMCaa',
);

/** Pyth Solana Receiver; the same address on devnet and mainnet. */
export const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');

/** Pyth reference equity feeds (Hermes, stable channel). */
export const FEEDS = {
  'Equity.US.AAPL/USD': '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688',
  'Equity.US.NVDA/USD': '0xb1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593',
} as const;
export const AAPL_FEED = FEEDS['Equity.US.AAPL/USD'];

/** Calendar 0 is US equities, as in `MarketCalendar`. */
export const US_EQUITY_CALENDAR_ID = 0;
export const REGULAR_OPEN_MINUTE = 9 * 60 + 30;
export const REGULAR_CLOSE_MINUTE = 16 * 60;

/** The program's defaults, from `constants.rs`. */
export const DEFAULT_MAX_PRICE_AGE_SECS = 60;
export const DEFAULT_MAX_CONF_BPS = 100;
export const DEFAULT_MAX_DIVERGENCE_BPS = 150;
/**
 * Outer bound on a Pyth `PriceUpdateV2` read, past which `observe` fails hard
 * rather than returning a typed refusal. The program's own tests use 3600; the
 * gate's tighter `max_price_age` is what an in-session read has to satisfy.
 */
export const PYTH_OUTER_MAX_AGE_SECS = 3600;

export function explorer(kind: 'tx' | 'address', value: string): string {
  return `https://explorer.solana.com/${kind}/${value}?cluster=devnet`;
}

export function connection(): Connection {
  return new Connection(RPC_URL, 'confirmed');
}

// --- keys ------------------------------------------------------------------

export function loadKeypair(path: string): Keypair {
  const bytes = JSON.parse(readFileSync(path, 'utf8')) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

/** The deploy wallet: `SOLANA_WALLET`, else the Solana CLI default. */
export function wallet(): Keypair {
  const path = process.env.SOLANA_WALLET ?? join(homedir(), '.config', 'solana', 'id.json');
  return loadKeypair(path);
}

/** Load a keypair from `keys/<name>.json`, generating it on first use. */
export function localKeypair(name: string): Keypair {
  mkdirSync(KEYS_DIR, { recursive: true });
  const path = join(KEYS_DIR, `${name}.json`);
  if (existsSync(path)) return loadKeypair(path);
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

// --- PDAs ------------------------------------------------------------------

export function registryPda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('registry')], PROGRAM_ID)[0];
}

export function calendarPda(id: number): PublicKey {
  const le = Buffer.alloc(2);
  le.writeUInt16LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from('calendar'), le], PROGRAM_ID)[0];
}

export function securityPda(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('security'), mint.toBuffer()], PROGRAM_ID)[0];
}

// --- borsh, the small subset we need ----------------------------------------

class Writer {
  private parts: Buffer[] = [];
  u8(v: number) {
    const b = Buffer.alloc(1);
    b.writeUInt8(v);
    this.parts.push(b);
    return this;
  }
  u16(v: number) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(v);
    this.parts.push(b);
    return this;
  }
  u32(v: number) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(v);
    this.parts.push(b);
    return this;
  }
  bytes(v: Uint8Array | Buffer) {
    this.parts.push(Buffer.from(v));
    return this;
  }
  pubkey(v: PublicKey) {
    return this.bytes(v.toBuffer());
  }
  done(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export class Reader {
  off = 0;
  constructor(private buf: Buffer) {}
  u8() {
    return this.buf.readUInt8(this.off++);
  }
  bool() {
    return this.u8() !== 0;
  }
  u16() {
    const v = this.buf.readUInt16LE(this.off);
    this.off += 2;
    return v;
  }
  u32() {
    const v = this.buf.readUInt32LE(this.off);
    this.off += 4;
    return v;
  }
  i32() {
    const v = this.buf.readInt32LE(this.off);
    this.off += 4;
    return v;
  }
  u64() {
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    return v;
  }
  i64() {
    const v = this.buf.readBigInt64LE(this.off);
    this.off += 8;
    return v;
  }
  u128() {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  }
  bytes(n: number) {
    const v = this.buf.subarray(this.off, this.off + n);
    this.off += n;
    return Buffer.from(v);
  }
  pubkey() {
    return new PublicKey(this.bytes(32));
  }
}

// --- instructions ----------------------------------------------------------

const DISC = {
  init_registry: [131, 22, 4, 103, 24, 94, 163, 239],
  init_calendar: [178, 150, 90, 163, 154, 72, 222, 102],
  append_calendar_entries: [245, 140, 58, 190, 25, 158, 14, 92],
  register_security: [202, 35, 140, 58, 166, 213, 77, 169],
  sync_security: [] as number[], // filled from the IDL below
  probe_security: [161, 26, 227, 99, 27, 204, 146, 209],
} as const;

const ACCOUNT_DISC = {
  Registry: [47, 174, 110, 246, 184, 182, 252, 218],
  MarketCalendar: [3, 21, 133, 9, 156, 12, 91, 73],
  SecurityState: [61, 133, 136, 156, 159, 96, 12, 57],
} as const;

const EVENT_DISC = {
  Refused: [230, 49, 133, 208, 106, 62, 106, 169],
  SecuritySynced: [199, 166, 254, 154, 105, 76, 45, 126],
  SecurityRegistered: [27, 89, 17, 195, 167, 131, 214, 16],
} as const;

/** Cross-check every hard-coded discriminator against the built IDL. */
function checkAgainstIdl(): void {
  const idlPath = join(ROOT, 'target', 'idl', 'deliverable.json');
  const fallback = join(ROOT, 'sdk', 'idl', 'deliverable.json');
  const path = existsSync(idlPath) ? idlPath : fallback;
  const idl = JSON.parse(readFileSync(path, 'utf8')) as {
    address: string;
    instructions: { name: string; discriminator: number[] }[];
    accounts: { name: string; discriminator: number[] }[];
    events: { name: string; discriminator: number[] }[];
  };
  const same = (a: readonly number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
  for (const [name, disc] of Object.entries(DISC)) {
    const ix = idl.instructions.find((i) => i.name === name);
    if (!ix) throw new Error(`IDL has no instruction ${name}`);
    if (name === 'sync_security') {
      (DISC as Record<string, number[]>).sync_security = ix.discriminator;
      continue;
    }
    if (!same(disc, ix.discriminator)) throw new Error(`discriminator mismatch for ${name}`);
  }
  for (const [name, disc] of Object.entries(ACCOUNT_DISC)) {
    const acc = idl.accounts.find((a) => a.name === name);
    if (!acc || !same(disc, acc.discriminator)) throw new Error(`account discriminator mismatch for ${name}`);
  }
  for (const [name, disc] of Object.entries(EVENT_DISC)) {
    const ev = idl.events.find((e) => e.name === name);
    if (!ev || !same(disc, ev.discriminator)) throw new Error(`event discriminator mismatch for ${name}`);
  }
}
checkAgainstIdl();

function ix(name: keyof typeof DISC, keys: TransactionInstruction['keys'], args: Buffer = Buffer.alloc(0)) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys,
    data: Buffer.concat([Buffer.from(DISC[name]), args]),
  });
}

const w = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false) => ({ pubkey, isSigner, isWritable: false });

export function initRegistryIx(authority: PublicKey, attestor: PublicKey) {
  return ix(
    'init_registry',
    [w(authority, true), w(registryPda()), r(SystemProgram.programId)],
    new Writer().pubkey(attestor).done(),
  );
}

export function initCalendarIx(authority: PublicKey, id: number, openMinute: number, closeMinute: number) {
  return ix(
    'init_calendar',
    [w(authority, true), r(registryPda()), w(calendarPda(id)), r(SystemProgram.programId)],
    new Writer().u16(id).u16(openMinute).u16(closeMinute).done(),
  );
}

export interface CalendarEntry {
  dateKey: number;
  kind: number; // 0 closed, 1 early close
  closeMinute: number;
}

export const ENTRY_CLOSED = 0;
export const ENTRY_EARLY_CLOSE = 1;

export function appendCalendarEntriesIx(authority: PublicKey, calendarId: number, entries: CalendarEntry[]) {
  const wr = new Writer().u32(entries.length);
  for (const e of entries) wr.u16(e.dateKey).u8(e.kind).u16(e.closeMinute);
  return ix('append_calendar_entries', [r(authority, true), w(calendarPda(calendarId))], wr.done());
}

export type OracleSource =
  | { kind: 'Scope'; index: number }
  | { kind: 'Pyth'; feedId: Buffer; maxAge: number };

export type OracleBinding =
  | { kind: 'Pair'; primary: OracleSource; secondary: OracleSource }
  | { kind: 'SingleDeclared'; primary: OracleSource };

function writeSource(wr: Writer, s: OracleSource) {
  if (s.kind === 'Scope') wr.u8(0).u16(s.index);
  else wr.u8(1).bytes(s.feedId).u32(s.maxAge);
}

export function registerSecurityIx(args: {
  authority: PublicKey;
  mint: PublicKey;
  calendarId: number;
  symbol: string;
  sources: OracleBinding;
  maxPriceAge: number;
  maxConfBps: number;
  maxDivergenceBps: number;
}) {
  const symbol = Buffer.alloc(12);
  Buffer.from(args.symbol, 'ascii').copy(symbol, 0, 0, 12);
  const wr = new Writer().bytes(symbol);
  if (args.sources.kind === 'Pair') {
    wr.u8(0);
    writeSource(wr, args.sources.primary);
    writeSource(wr, args.sources.secondary);
  } else {
    wr.u8(1);
    writeSource(wr, args.sources.primary);
  }
  wr.u32(args.maxPriceAge).u32(args.maxConfBps).u32(args.maxDivergenceBps);
  return ix(
    'register_security',
    [
      w(args.authority, true),
      r(registryPda()),
      r(args.mint),
      r(calendarPda(args.calendarId)),
      w(securityPda(args.mint)),
      r(SystemProgram.programId),
    ],
    wr.done(),
  );
}

/**
 * `sync_security`: write down what the mint and the oracle say now. For a
 * single declared source the secondary slot is the primary again, and is never
 * read.
 */
export function syncSecurityIx(mint: PublicKey, oracle: PublicKey) {
  return ix('sync_security', [w(securityPda(mint)), r(mint), r(oracle), r(oracle)]);
}

/** `probe_security`: ask the gate for its verdict and record it. */
export function probeSecurityIx(mint: PublicKey, calendarId: number, oracle: PublicKey) {
  return ix('probe_security', [w(securityPda(mint)), r(calendarPda(calendarId)), r(mint), r(oracle), r(oracle)]);
}

// --- decoders --------------------------------------------------------------

function expectDisc(data: Buffer, disc: readonly number[], name: string): Reader {
  if (!data.subarray(0, 8).equals(Buffer.from(disc))) throw new Error(`not a ${name} account`);
  const rd = new Reader(data);
  rd.off = 8;
  return rd;
}

export function decodeRegistry(data: Buffer) {
  const rd = expectDisc(data, ACCOUNT_DISC.Registry, 'Registry');
  return { authority: rd.pubkey(), attestor: rd.pubkey(), paused: rd.bool(), bump: rd.u8() };
}

export function decodeCalendar(data: Buffer) {
  const rd = expectDisc(data, ACCOUNT_DISC.MarketCalendar, 'MarketCalendar');
  const authority = rd.pubkey();
  const id = rd.u16();
  const version = rd.u16();
  const regularOpenMinute = rd.u16();
  const regularCloseMinute = rd.u16();
  const bump = rd.u8();
  const n = rd.u32();
  const entries: CalendarEntry[] = [];
  for (let i = 0; i < n; i++) entries.push({ dateKey: rd.u16(), kind: rd.u8(), closeMinute: rd.u16() });
  return { authority, id, version, regularOpenMinute, regularCloseMinute, bump, entries };
}

function readSource(rd: Reader): OracleSource {
  const tag = rd.u8();
  if (tag === 0) return { kind: 'Scope', index: rd.u16() };
  if (tag === 1) return { kind: 'Pyth', feedId: rd.bytes(32), maxAge: rd.u32() };
  throw new Error(`unknown OracleSource tag ${tag}`);
}

function readObservation(rd: Reader) {
  return { price: rd.i64(), conf: rd.u64(), expo: rd.i32(), publishTs: rd.i64() };
}

export function decodeSecurityState(data: Buffer) {
  const rd = expectDisc(data, ACCOUNT_DISC.SecurityState, 'SecurityState');
  const underlyingMint = rd.pubkey();
  const symbolBytes = rd.bytes(12);
  const symbol = symbolBytes.subarray(0, symbolBytes.indexOf(0) === -1 ? 12 : symbolBytes.indexOf(0)).toString('ascii');
  const calendarId = rd.u16();
  const decimals = rd.u8();
  const bump = rd.u8();
  const bindingTag = rd.u8();
  let sources: OracleBinding;
  if (bindingTag === 0) sources = { kind: 'Pair', primary: readSource(rd), secondary: readSource(rd) };
  else if (bindingTag === 1) sources = { kind: 'SingleDeclared', primary: readSource(rd) };
  else throw new Error(`unknown OracleBinding tag ${bindingTag}`);
  const observedMultiplier = rd.u128();
  const pendingMultiplier = rd.u128();
  const pendingEffectiveTs = rd.i64();
  const multiplierEpoch = rd.u64();
  const mintPaused = rd.bool();
  const transferHook = rd.u8() === 1 ? rd.pubkey() : null;
  const primary = readObservation(rd);
  const secondary = rd.u8() === 1 ? readObservation(rd) : null;
  const syncedTs = rd.i64();
  const halt = { halted: rd.bool(), sinceTs: rd.i64(), attestedTs: rd.i64(), source: rd.u8() };
  const maxPriceAge = rd.u32();
  const maxConfBps = rd.u32();
  const maxDivergenceBps = rd.u32();
  const refusals = rd.u32();
  const lastRefusalCode = rd.u8();
  const lastRefusalTs = rd.i64();
  return {
    underlyingMint,
    symbol,
    calendarId,
    decimals,
    bump,
    sources,
    observedMultiplier,
    pendingMultiplier,
    pendingEffectiveTs,
    multiplierEpoch,
    mintPaused,
    transferHook,
    primary,
    secondary,
    syncedTs,
    halt,
    maxPriceAge,
    maxConfBps,
    maxDivergenceBps,
    refusals,
    lastRefusalCode,
    lastRefusalTs,
  };
}

/** Pyth `PriceUpdateV2`, as the receiver lays it out. */
export function decodePriceUpdateV2(data: Buffer) {
  const rd = new Reader(data);
  rd.off = 8;
  const writeAuthority = rd.pubkey();
  const levelTag = rd.u8();
  const verificationLevel = levelTag === 1 ? 'Full' : `Partial(${rd.u8()} signatures)`;
  const feedId = rd.bytes(32).toString('hex');
  const price = rd.i64();
  const conf = rd.u64();
  const exponent = rd.i32();
  const publishTime = rd.i64();
  const prevPublishTime = rd.i64();
  const emaPrice = rd.i64();
  const emaConf = rd.u64();
  const postedSlot = rd.u64();
  return { writeAuthority, verificationLevel, feedId, price, conf, exponent, publishTime, prevPublishTime, emaPrice, emaConf, postedSlot };
}

/** Anchor events out of `Program data:` log lines. */
export function parseEvents(logs: string[]) {
  const out: { name: string; fields: Record<string, unknown> }[] = [];
  for (const line of logs) {
    const m = line.match(/^Program data: (.+)$/);
    if (!m) continue;
    const buf = Buffer.from(m[1], 'base64');
    const head = buf.subarray(0, 8);
    const rd = new Reader(buf);
    rd.off = 8;
    if (head.equals(Buffer.from(EVENT_DISC.Refused))) {
      out.push({ name: 'Refused', fields: { security: rd.pubkey().toBase58(), code: rd.u8(), at: rd.i64() } });
    } else if (head.equals(Buffer.from(EVENT_DISC.SecuritySynced))) {
      out.push({
        name: 'SecuritySynced',
        fields: {
          security: rd.pubkey().toBase58(),
          multiplier: rd.u128(),
          multiplierEpoch: rd.u64(),
          price: rd.i64(),
          expo: rd.i32(),
          publishTs: rd.i64(),
          at: rd.i64(),
        },
      });
    }
  }
  return out;
}

export const REFUSAL_NAMES: Record<number, string> = {
  1: 'MarketClosed',
  2: 'Halted',
  3: 'OracleStale',
  4: 'ConfidenceBlown',
  5: 'MultiplierPending',
  6: 'IssuerPaused',
  7: 'HookAttached',
  8: 'SourcesDisagree',
  9: 'SingleSource',
};

/** `price * 10^expo` as a decimal string, exactly. */
export function fmtFixed(value: bigint, expo: number): string {
  if (expo >= 0) return (value * 10n ** BigInt(expo)).toString();
  const neg = value < 0n;
  const s = (neg ? -value : value).toString().padStart(-expo + 1, '0');
  const cut = s.length + expo;
  return `${neg ? '-' : ''}${s.slice(0, cut)}.${s.slice(cut)}`;
}

// --- sending and recording --------------------------------------------------

export interface Deployment {
  cluster: 'devnet';
  programId: string;
  [key: string]: unknown;
  transactions: { label: string; signature: string; slot?: number; blockTime?: number | null }[];
}

export function readDeployment(): Deployment {
  if (!existsSync(DEPLOYMENT_FILE)) {
    return { cluster: 'devnet', programId: PROGRAM_ID.toBase58(), transactions: [] };
  }
  return JSON.parse(readFileSync(DEPLOYMENT_FILE, 'utf8')) as Deployment;
}

export function writeDeployment(d: Deployment): void {
  writeFileSync(DEPLOYMENT_FILE, JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n');
}

export function recordTx(label: string, signature: string, slot?: number, blockTime?: number | null): void {
  const d = readDeployment();
  d.transactions.push({ label, signature, slot, blockTime });
  writeDeployment(d);
}

export function recordField(key: string, value: unknown): void {
  const d = readDeployment();
  d[key] = value;
  writeDeployment(d);
}

/** Send legacy instructions, confirm, record, and return the signature and logs. */
export async function send(
  conn: Connection,
  label: string,
  ixs: TransactionInstruction[],
  signers: Signer[],
  computeUnits = 200_000,
): Promise<{ signature: string; logs: string[] }> {
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 }),
    ...ixs,
  );
  const signature = await sendAndConfirmTransaction(conn, tx, signers, { commitment: 'confirmed' });
  const info = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  recordTx(label, signature, info?.slot, info?.blockTime);
  console.log(`${label}: ${signature}`);
  console.log(`  ${explorer('tx', signature)}`);
  return { signature, logs: info?.meta?.logMessages ?? [] };
}
