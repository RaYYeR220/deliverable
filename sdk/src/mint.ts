/**
 * What a Token-2022 mint says about itself: the ScaledUiAmount multiplier (the only
 * corporate-action signal xStocks have), and the two issuer levers the gate reads,
 * `Pausable` and `TransferHook`.
 *
 * Decoding goes through `@solana-program/token-2022`'s generated mint codec rather than
 * a hand-written TLV walk, so the layout is the token program's own.
 */
import { unwrapOption, type Address, type ReadonlyUint8Array } from '@solana/kit';
import { getMintDecoder, type Extension } from '@solana-program/token-2022';

import { f64ToFixed } from './fixed.js';

export const TOKEN_2022_PROGRAM_ADDRESS = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' as Address;
export const TOKEN_PROGRAM_ADDRESS = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address;

/** `OptionalNonZeroPubkey::default()`: the all-zero key the token program writes for "none". */
const DEFAULT_ADDRESS = '11111111111111111111111111111111';

export interface ScaledUiAmount {
  authority: Address | null;
  /** In force before `newMultiplierEffectiveTimestamp`. */
  multiplier: number;
  /** In force from `newMultiplierEffectiveTimestamp`, inclusive. */
  newMultiplier: number;
  newMultiplierEffectiveTimestamp: bigint;
}

export interface MintState {
  address: Address;
  decimals: number;
  supply: bigint;
  /** Null when the mint has no ScaledUiAmount extension; its multiplier is then 1. */
  scaledUiAmount: ScaledUiAmount | null;
  /** `PausableConfig.paused`. A mint without the extension cannot be paused. */
  paused: boolean;
  /** `TransferHook.program_id`, once it stops being empty. */
  transferHookProgramId: Address | null;
  symbol: string | null;
  name: string | null;
}

function findExtension<K extends Extension['__kind']>(
  extensions: readonly Extension[],
  kind: K,
): Extract<Extension, { __kind: K }> | undefined {
  return extensions.find((e): e is Extract<Extension, { __kind: K }> => e.__kind === kind);
}

const nonDefault = (address: Address): Address | null => (address === DEFAULT_ADDRESS ? null : address);

export function decodeMintState(address: Address, data: ReadonlyUint8Array): MintState {
  const mint = getMintDecoder().decode(data);
  const extensions = unwrapOption(mint.extensions) ?? [];

  const scaled = findExtension(extensions, 'ScaledUiAmountConfig');
  const pausable = findExtension(extensions, 'PausableConfig');
  const hook = findExtension(extensions, 'TransferHook');
  const metadata = findExtension(extensions, 'TokenMetadata');

  return {
    address,
    decimals: mint.decimals,
    supply: mint.supply,
    scaledUiAmount: scaled
      ? {
          authority: nonDefault(scaled.authority),
          multiplier: scaled.multiplier,
          newMultiplier: scaled.newMultiplier,
          newMultiplierEffectiveTimestamp: scaled.newMultiplierEffectiveTimestamp,
        }
      : null,
    paused: pausable?.paused ?? false,
    transferHookProgramId: hook ? nonDefault(hook.programId) : null,
    symbol: metadata?.symbol ?? null,
    name: metadata?.name ?? null,
  };
}

/** Mirrors `scaled_ui::MintMultiplier`. */
export interface MintMultiplier {
  /** In force at the instant asked about, 1e12 fixed point. */
  effective: bigint;
  /** A scheduled change that has not taken effect yet. */
  pending: { multiplier: bigint; effectiveTs: bigint } | null;
  /** Changes exactly when the effective multiplier changes. */
  epochKey: bigint;
}

/**
 * `effective_from_cfg`: `new_multiplier` takes over at its effective timestamp,
 * inclusive. Both fields are decoded, as in the program, so an invalid value in
 * either one fails the read.
 */
export function mintMultiplierAt(scaled: ScaledUiAmount, now: bigint): MintMultiplier {
  const old = f64ToFixed(scaled.multiplier);
  const next = f64ToFixed(scaled.newMultiplier);
  const effectiveTs = scaled.newMultiplierEffectiveTimestamp;
  if (now >= effectiveTs) return { effective: next, pending: null, epochKey: effectiveTs };
  return { effective: old, pending: { multiplier: next, effectiveTs }, epochKey: 0n };
}

/**
 * The float multiplier the token program and the RPC apply to UI amounts at `at`
 * (`ScaledUiAmountConfig::current_multiplier`). Only valid back to the previous
 * multiplier change, which the mint does not record; see `balance.ts` for how a
 * historical instant is handled.
 */
export function uiMultiplierAt(scaled: ScaledUiAmount | null, at: bigint): number {
  if (!scaled) return 1;
  return at >= scaled.newMultiplierEffectiveTimestamp ? scaled.newMultiplier : scaled.multiplier;
}

export function hasTransferHook(mint: MintState): boolean {
  return mint.transferHookProgramId !== null;
}
