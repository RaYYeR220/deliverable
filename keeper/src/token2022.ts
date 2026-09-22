import { encodeBase58, tryDecodeBase58 } from './base58.ts';

export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/**
 * Token-2022 dispatches extension instructions on two bytes: the outer `TokenInstruction`
 * discriminant, then the extension's own sub-instruction discriminant.
 *
 *   TokenInstruction::ScaledUiAmountExtension        = 43
 *   ScaledUiAmountMintInstruction::Initialize        = 0
 *   ScaledUiAmountMintInstruction::UpdateMultiplier  = 1
 *
 * Source: solana-program/token-2022, interface/src/instruction.rs (`43 => Self::ScaledUiAmountExtension`)
 * and interface/src/extension/scaled_ui_amount/instruction.rs (enum ScaledUiAmountMintInstruction).
 * Confirmed on mainnet against the mints listed in mints.ts.
 */
export const SCALED_UI_AMOUNT_EXTENSION_IX = 43;
export const SCALED_UI_AMOUNT_INITIALIZE = 0;
export const SCALED_UI_AMOUNT_UPDATE_MULTIPLIER = 1;

/** `UpdateMultiplierInstructionData` is `#[repr(C)]` { PodF64 multiplier; i64 effective_timestamp }. */
const UPDATE_MULTIPLIER_DATA_LEN = 8 + 8;
/** `InitializeInstructionData` is { OptionalNonZeroPubkey authority; PodF64 multiplier }. */
const INITIALIZE_DATA_LEN = 32 + 8;

/** `ExtensionType::ScaledUiAmount` — the 26th variant of a zero-based enum. */
const EXT_SCALED_UI_AMOUNT = 25;
/** `ExtensionType::TokenMetadata` — variable length, so it is parsed defensively. */
const EXT_TOKEN_METADATA = 19;

const MINT_BASE_LEN = 82;
/** Base mint, padded out to the size of a token account, then a 1-byte account type tag. */
const ACCOUNT_TYPE_OFFSET = 165;
const TLV_START = ACCOUNT_TYPE_OFFSET + 1;
const ACCOUNT_TYPE_MINT = 1;

export interface TlvEntry {
  type: number;
  length: number;
  value: Buffer;
}

export function readTlvEntries(data: Buffer): TlvEntry[] {
  if (data.length <= TLV_START || data[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return [];

  const entries: TlvEntry[] = [];
  let offset = TLV_START;
  while (offset + 4 <= data.length) {
    const type = data.readUInt16LE(offset);
    const length = data.readUInt16LE(offset + 2);
    if (type === 0 && length === 0) break;
    const end = offset + 4 + length;
    if (end > data.length) break;
    entries.push({ type, length, value: data.subarray(offset + 4, end) });
    offset = end;
  }
  return entries;
}

export interface ScaledUiAmountConfig {
  /** `None` is encoded as the all-zero pubkey. */
  authority: string | null;
  multiplier: number;
  newMultiplier: number;
  newMultiplierEffectiveTimestamp: number;
}

/**
 * `ScaledUiAmountConfig` is `#[repr(C)]`:
 *   authority: Pubkey (32)
 *   multiplier: PodF64 (8, little-endian f64)
 *   new_multiplier_effective_timestamp: i64 (8)   <- note: comes BEFORE new_multiplier
 *   new_multiplier: PodF64 (8)
 */
export function decodeScaledUiAmountConfig(value: Buffer): ScaledUiAmountConfig | null {
  if (value.length < 56) return null;
  const authorityBytes = value.subarray(0, 32);
  const isNone = authorityBytes.every((byte) => byte === 0);
  return {
    authority: isNone ? null : encodeBase58(authorityBytes),
    multiplier: value.readDoubleLE(32),
    newMultiplierEffectiveTimestamp: Number(value.readBigInt64LE(40)),
    newMultiplier: value.readDoubleLE(48),
  };
}

export interface TokenMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/** spl-token-metadata-interface: update_authority(32) mint(32) then three borsh strings. */
export function decodeTokenMetadata(value: Buffer): TokenMetadata | null {
  let offset = 64;
  const strings: string[] = [];
  for (let i = 0; i < 3; i++) {
    if (offset + 4 > value.length) return null;
    const length = value.readUInt32LE(offset);
    offset += 4;
    if (length > value.length - offset) return null;
    strings.push(value.subarray(offset, offset + length).toString('utf8'));
    offset += length;
  }
  return { name: strings[0]!, symbol: strings[1]!, uri: strings[2]! };
}

export interface MintState {
  address: string;
  decimals: number;
  supply: bigint;
  mintAuthority: string | null;
  scaledUiAmount: ScaledUiAmountConfig | null;
  metadata: TokenMetadata | null;
}

export function decodeMint(address: string, data: Buffer): MintState | null {
  if (data.length < MINT_BASE_LEN) return null;

  const hasMintAuthority = data.readUInt32LE(0) === 1;
  const state: MintState = {
    address,
    decimals: data[44]!,
    supply: data.readBigUInt64LE(36),
    mintAuthority: hasMintAuthority ? encodeBase58(data.subarray(4, 36)) : null,
    scaledUiAmount: null,
    metadata: null,
  };

  for (const entry of readTlvEntries(data)) {
    if (entry.type === EXT_SCALED_UI_AMOUNT) state.scaledUiAmount = decodeScaledUiAmountConfig(entry.value);
    else if (entry.type === EXT_TOKEN_METADATA) state.metadata = decodeTokenMetadata(entry.value);
  }
  return state;
}

/**
 * Mirrors `ScaledUiAmountConfig::current_multiplier`: once the effective timestamp is
 * reached the pending multiplier IS the multiplier, and the `multiplier` field becomes
 * a historical snapshot. Reading `multiplier` alone silently reports a stale figure.
 */
export function effectiveMultiplier(config: ScaledUiAmountConfig, atUnixSeconds: number): number {
  return atUnixSeconds >= config.newMultiplierEffectiveTimestamp ? config.newMultiplier : config.multiplier;
}

export interface UpdateMultiplierInstruction {
  kind: 'update-multiplier';
  mint: string;
  authority: string | null;
  newMultiplier: number;
  effectiveTimestamp: number;
}

export interface InitializeScaledUiAmountInstruction {
  kind: 'initialize';
  mint: string;
  authority: string | null;
  multiplier: number;
}

export type ScaledUiAmountInstruction = UpdateMultiplierInstruction | InitializeScaledUiAmountInstruction;

export interface RawInstruction {
  programId: string;
  /** Account addresses in instruction order. */
  accounts: string[];
  /** Base58, exactly as `getTransaction` with `encoding: "json"` returns it. */
  data: string;
}

/**
 * Returns null for anything that is not a ScaledUiAmount extension instruction. The
 * multiplier authority also issues plain TransferChecked traffic on the same key, so
 * signature-level filtering is not enough — every instruction has to be decoded.
 */
export function decodeScaledUiAmountInstruction(ix: RawInstruction): ScaledUiAmountInstruction | null {
  if (ix.programId !== TOKEN_2022_PROGRAM_ID) return null;

  const data = tryDecodeBase58(ix.data);
  if (!data || data.length < 2 || data[0] !== SCALED_UI_AMOUNT_EXTENSION_IX) return null;

  const body = Buffer.from(data.buffer, data.byteOffset + 2, data.length - 2);
  const mint = ix.accounts[0];
  if (!mint) return null;

  if (data[1] === SCALED_UI_AMOUNT_UPDATE_MULTIPLIER && body.length >= UPDATE_MULTIPLIER_DATA_LEN) {
    return {
      kind: 'update-multiplier',
      mint,
      authority: ix.accounts[1] ?? null,
      newMultiplier: body.readDoubleLE(0),
      effectiveTimestamp: Number(body.readBigInt64LE(8)),
    };
  }

  if (data[1] === SCALED_UI_AMOUNT_INITIALIZE && body.length >= INITIALIZE_DATA_LEN) {
    const authorityBytes = body.subarray(0, 32);
    return {
      kind: 'initialize',
      mint,
      authority: authorityBytes.every((byte) => byte === 0) ? null : encodeBase58(authorityBytes),
      multiplier: body.readDoubleLE(32),
    };
  }

  return null;
}
