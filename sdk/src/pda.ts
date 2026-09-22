/**
 * The one PDA Codama could not generate. `OptionSeries` is seeded from instruction
 * arguments (instructions/series.rs, `CreateSeries`):
 *
 *   [b"series", underlying_mint, expiry_ts.to_le_bytes(), strike0.to_le_bytes(), [kind as u8]]
 *
 * and the same seeds are re-derived from the stored fields by every instruction that
 * takes a series (`SeriesSigner`). Every other PDA comes from src/generated/pdas.
 */
import {
  getAddressEncoder,
  getI64Encoder,
  getProgramDerivedAddress,
  getU64Encoder,
  getU8Encoder,
  type Address,
  type ProgramDerivedAddress,
} from '@solana/kit';

import { DELIVERABLE_PROGRAM_ADDRESS, OptionKind, SERIES_SEED } from './generated/index.js';

export interface SeriesSeeds {
  underlyingMint: Address;
  expiryTs: bigint;
  strike0: bigint;
  kind: OptionKind;
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
      getI64Encoder().encode(seeds.expiryTs),
      getU64Encoder().encode(seeds.strike0),
      getU8Encoder().encode(seeds.kind === OptionKind.Put ? 1 : 0),
    ],
  });
}
