/**
 * Price observations, decoded the way `programs/deliverable/src/oracle/` decodes them,
 * and the two comparisons the gate makes on them.
 */
import { getAddressDecoder, type Address, type ReadonlyUint8Array } from '@solana/kit';

import type { Observation, OracleSource } from './generated/index.js';
import { mulDivFloor, ProgramMathError, SCALE } from './fixed.js';

/** `constants::SCOPE_PROGRAM` / `SCOPE_PRICES`. */
export const SCOPE_PROGRAM_ADDRESS = 'HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ' as Address;
export const SCOPE_PRICES_ADDRESS = '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH' as Address;

/**
 * Scope's `TokenMetadatas`, which labels each of the 512 price slots ("Checked AAPLx/USD",
 * "PythLazer AAPLx/USD"). Found by following the `Configuration` whose `oracle_prices`
 * is `SCOPE_PRICES_ADDRESS` (Configuration 6cMwdbrJ95D7v5655Zsoe7oXmjQJMnagWK8EcdG6qmGM,
 * read 2026-09-22). The layout is the one keeper/src/scope-oracle.ts verified.
 */
export const SCOPE_TOKEN_METADATAS_ADDRESS = '3wHxoHowen78mskgqKQmaYVQV8Mqd5PUFXja2xcfviSV' as Address;

/** `constants::SCOPE_PRICES_OFFSET`, `SCOPE_ENTRY_SIZE`, `SCOPE_MAX_ENTRIES`. */
export const SCOPE_PRICES_OFFSET = 40;
export const SCOPE_ENTRY_SIZE = 56;
export const SCOPE_MAX_ENTRIES = 512;

/** `pyth_solana_receiver_sdk::ID`, the owner of every `PriceUpdateV2`. */
export const PYTH_RECEIVER_PROGRAM_ADDRESS = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ' as Address;
/** First eight bytes of sha256("account:PriceUpdateV2"); asserted in test/oracle.test.ts. */
export const PRICE_UPDATE_V2_DISCRIMINATOR: ReadonlyUint8Array = new Uint8Array([34, 241, 35, 99, 157, 126, 244, 205]);

export type { Observation };

/** Raised where `observe` would fail the transaction with a non-refusal error. */
export class OracleReadError extends Error {
  constructor(
    readonly variant: 'OracleSourceMismatch' | 'ScopeIndexOutOfRange' | 'MathOverflow' | 'OracleStale',
    message: string,
  ) {
    super(message);
    this.name = 'OracleReadError';
  }
}

const I64_MAX = (1n << 63n) - 1n;

function view(data: ReadonlyUint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

/** `OracleSource::reports_confidence`: only Pyth publishes a band. */
export function reportsConfidence(source: OracleSource): boolean {
  return source.__kind === 'Pyth';
}

/** `scope::decode`. */
export function decodeScopeEntry(data: ReadonlyUint8Array, index: number): Observation {
  if (index < 0 || index >= SCOPE_MAX_ENTRIES) {
    throw new OracleReadError('ScopeIndexOutOfRange', `Scope index ${index} is out of range`);
  }
  const start = SCOPE_PRICES_OFFSET + index * SCOPE_ENTRY_SIZE;
  if (data.length < start + 32) {
    throw new OracleReadError('ScopeIndexOutOfRange', `Scope account too short for index ${index}`);
  }
  const v = view(data);
  const value = v.getBigUint64(start, true);
  const exp = v.getBigUint64(start + 8, true);
  const unixTimestamp = v.getBigUint64(start + 24, true);

  if (value === 0n) throw new OracleReadError('OracleSourceMismatch', `Scope index ${index} is unwritten`);
  if (exp > 30n) throw new OracleReadError('MathOverflow', `Scope index ${index} exponent ${exp} out of range`);
  if (value > I64_MAX || unixTimestamp > I64_MAX) {
    throw new OracleReadError('MathOverflow', `Scope index ${index} does not fit in i64`);
  }
  return { price: value, conf: 0n, expo: -Number(exp), publishTs: unixTimestamp };
}

export interface PriceUpdateV2 {
  writeAuthority: Address;
  verificationLevel: { kind: 'Partial'; numSignatures: number } | { kind: 'Full' };
  feedId: ReadonlyUint8Array;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  prevPublishTime: bigint;
  emaPrice: bigint;
  emaConf: bigint;
  postedSlot: bigint;
}

/**
 * Borsh layout of `PriceUpdateV2`: disc(8) | write_authority(32) | verification_level
 * (enum: 0 = Partial { num_signatures: u8 }, 1 = Full) | PriceFeedMessage { feed_id(32),
 * price i64, conf u64, exponent i32, publish_time i64, prev_publish_time i64,
 * ema_price i64, ema_conf u64 } | posted_slot u64.
 */
export function decodePriceUpdateV2(data: ReadonlyUint8Array): PriceUpdateV2 {
  if (data.length < 8 || !PRICE_UPDATE_V2_DISCRIMINATOR.every((b, i) => data[i] === b)) {
    throw new OracleReadError('OracleSourceMismatch', 'account is not a PriceUpdateV2');
  }
  const v = view(data);
  const writeAuthority = getAddressDecoder().decode(data.subarray(8, 40));
  let o = 40;
  const tag = data[o];
  let verificationLevel: PriceUpdateV2['verificationLevel'];
  if (tag === 0) {
    verificationLevel = { kind: 'Partial', numSignatures: data[o + 1] ?? 0 };
    o += 2;
  } else if (tag === 1) {
    verificationLevel = { kind: 'Full' };
    o += 1;
  } else {
    throw new OracleReadError('OracleSourceMismatch', `unknown verification level ${tag}`);
  }
  const feedId = data.slice(o, o + 32);
  o += 32;
  const price = v.getBigInt64(o, true);
  const conf = v.getBigUint64(o + 8, true);
  const exponent = v.getInt32(o + 16, true);
  const publishTime = v.getBigInt64(o + 20, true);
  const prevPublishTime = v.getBigInt64(o + 28, true);
  const emaPrice = v.getBigInt64(o + 36, true);
  const emaConf = v.getBigUint64(o + 44, true);
  const postedSlot = v.getBigUint64(o + 52, true);
  return {
    writeAuthority,
    verificationLevel,
    feedId,
    price,
    conf,
    exponent,
    publishTime,
    prevPublishTime,
    emaPrice,
    emaConf,
    postedSlot,
  };
}

/**
 * `pyth::observe`: owner check, discriminator check, then
 * `get_price_no_older_than`, which also insists on full Wormhole verification. Any
 * failure there surfaces on-chain as `OracleStale`.
 */
export function observePyth(
  owner: Address,
  data: ReadonlyUint8Array,
  feedId: ReadonlyUint8Array,
  maxAge: number,
  now: bigint,
): Observation {
  if (owner !== PYTH_RECEIVER_PROGRAM_ADDRESS) {
    throw new OracleReadError('OracleSourceMismatch', `PriceUpdateV2 owned by ${owner}`);
  }
  const update = decodePriceUpdateV2(data);
  if (update.verificationLevel.kind !== 'Full') {
    throw new OracleReadError('OracleStale', 'PriceUpdateV2 is only partially verified');
  }
  if (!update.feedId.every((b, i) => feedId[i] === b)) {
    throw new OracleReadError('OracleStale', 'PriceUpdateV2 is for a different feed');
  }
  if (update.publishTime + BigInt(maxAge) < now) {
    throw new OracleReadError('OracleStale', `PriceUpdateV2 is older than ${maxAge}s`);
  }
  return { price: update.price, conf: update.conf, expo: update.exponent, publishTs: update.publishTime };
}

/** `oracle::observe` for one source against one account. */
export function observe(
  source: OracleSource,
  account: { address: Address; owner: Address; data: ReadonlyUint8Array },
  now: bigint,
): Observation {
  if (source.__kind === 'Scope') {
    if (account.owner !== SCOPE_PROGRAM_ADDRESS) {
      throw new OracleReadError('OracleSourceMismatch', `${account.address} is not owned by Scope`);
    }
    return decodeScopeEntry(account.data, source.index);
  }
  return observePyth(account.owner, account.data, source.feedId, source.maxAge, now);
}

function pow10(n: number): bigint {
  if (n > 30) throw new ProgramMathError('MathOverflow', 'exponent out of range');
  return 10n ** BigInt(n);
}

/** Raised where the gate itself would fail with a typed error rather than refuse. */
export class GateArithmeticError extends Error {
  constructor(
    readonly variant: 'ConfidenceBlown' | 'MathOverflow',
    message: string,
  ) {
    super(message);
    this.name = 'GateArithmeticError';
  }
}

/** `to_fixed`: `price * 10^expo` as 1e12 fixed point. */
export function toFixed(o: Observation): bigint {
  if (o.price <= 0n) throw new GateArithmeticError('ConfidenceBlown', 'price is zero or negative');
  if (o.expo <= 0) return mulDivFloor(o.price, SCALE, pow10(-o.expo));
  return o.price * SCALE * pow10(o.expo);
}

const U32_MAX = 0xffff_ffffn;
const saturateU32 = (v: bigint): number => Number(v > U32_MAX ? U32_MAX : v);

/** `conf_bps`: reported confidence as a fraction of the price, in basis points. */
export function confBps(o: Observation): number {
  if (o.price <= 0n) throw new GateArithmeticError('ConfidenceBlown', 'price is zero or negative');
  return saturateU32((o.conf * 10_000n) / o.price);
}

/** `divergence_bps`: distance between two observations in bps of the first. */
export function divergenceBps(a: Observation, b: Observation): number {
  const pa = toFixed(a);
  const pb = toFixed(b);
  if (pa <= 0n) throw new GateArithmeticError('ConfidenceBlown', 'price is zero or negative');
  const diff = pa > pb ? pa - pb : pb - pa;
  return saturateU32((diff * 10_000n) / pa);
}

/** A human-readable USD price, for display only. */
export function observationToNumber(o: Observation): number {
  return Number(o.price) * 10 ** o.expo;
}

export interface ScopeLabel {
  index: number;
  label: string;
}

const METADATA_ENTRY_LEN = 32 + 8 + 8 + 15 * 8;
const METADATAS_LEN = 8 + SCOPE_MAX_ENTRIES * METADATA_ENTRY_LEN;

/** `TokenMetadatas.metadatas_array[512]`: a 32-byte ASCII name per slot. */
export function decodeScopeLabels(data: ReadonlyUint8Array): ScopeLabel[] {
  if (data.length !== METADATAS_LEN) {
    throw new OracleReadError('OracleSourceMismatch', `TokenMetadatas is ${data.length} bytes, expected ${METADATAS_LEN}`);
  }
  const decoder = new TextDecoder();
  const out: ScopeLabel[] = [];
  for (let index = 0; index < SCOPE_MAX_ENTRIES; index++) {
    const offset = 8 + index * METADATA_ENTRY_LEN;
    const raw = data.subarray(offset, offset + 32);
    const end = raw.indexOf(0);
    const label = decoder.decode(end < 0 ? raw : raw.subarray(0, end)).trim();
    if (label) out.push({ index, label });
  }
  return out;
}

/**
 * The binding a security is registered with by convention (tests/harness.rs): the
 * `Checked` entry, whose cap and floor come from Chainlink, as primary and the
 * `PythLazer` entry as the independent second source.
 */
export function scopePairFor(labels: readonly ScopeLabel[], symbol: string): { checked?: number; lazer?: number } {
  const find = (prefix: string) =>
    labels.find((l) => l.label.toLowerCase() === `${prefix} ${symbol}/usd`.toLowerCase())?.index;
  const checked = find('Checked');
  const lazer = find('PythLazer');
  return {
    ...(checked !== undefined ? { checked } : {}),
    ...(lazer !== undefined ? { lazer } : {}),
  };
}
