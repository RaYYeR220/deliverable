/**
 * The one PDA Codama could not generate. `OptionSeries` is seeded from instruction
 * arguments (instructions/series.rs, `CreateSeries`):
 *
 *   [b"series", underlying_mint, quote_mint, expiry_ts, strike0, contract_raw_size,
 *    settlement_window_minutes, [kind as u8], [adjust_on_corporate_action as u8]]
 *
 * and the same seeds are re-derived from the stored fields by every instruction that
 * takes a series (`SeriesSigner`). Every other PDA comes from src/generated/pdas.
 *
 * Every term a writer is exposed to is in the address. It used to be only
 * `(mint, expiry, strike, kind)`, which meant the quote asset, the contract size,
 * the settlement window and whether the strike adjusts at all were fixed by whoever
 * listed the canonical slot first — so an SDK deriving "AAPLx $340 call, expiry X"
 * could land on a contract quoted in a worthless token with the adjustment off.
 */
import {
  getAddressEncoder,
  getBooleanEncoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getU16Encoder,
  getU64Encoder,
  getU8Encoder,
  type Address,
  type ProgramDerivedAddress,
} from '@solana/kit';

import { DELIVERABLE_PROGRAM_ADDRESS, OptionKind, SERIES_SEED } from './generated/index.js';

export interface SeriesSeeds {
  underlyingMint: Address;
  quoteMint: Address;
  expiryTs: bigint;
  strike0: bigint;
  contractRawSize: bigint;
  settlementWindowMinutes: number;
  kind: OptionKind;
  adjustOnCorporateAction: boolean;
}

export async function findSeriesPda(
  seeds: SeriesSeeds,
  config: { programAddress?: Address } = {},
): Promise<ProgramDerivedAddress> {
  return getProgramDerivedAddress({
    programAddress: config.programAddress ?? DELIVERABLE_PROGRAM_ADDRESS,
    seeds: [
      SERIES_SEED,
      getAddressEncoder().encode(seeds.underlyingMint),
      getAddressEncoder().encode(seeds.quoteMint),
      getI64Encoder().encode(seeds.expiryTs),
      getU64Encoder().encode(seeds.strike0),
      getU64Encoder().encode(seeds.contractRawSize),
      getU16Encoder().encode(seeds.settlementWindowMinutes),
      getU8Encoder().encode(seeds.kind === OptionKind.Put ? 1 : 0),
      getBooleanEncoder().encode(seeds.adjustOnCorporateAction),
    ],
  });
}
