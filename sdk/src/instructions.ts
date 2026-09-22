/**
 * Every instruction the program exposes has a typed builder in src/generated/instructions,
 * produced by Codama from the IDL (`get<Name>Instruction` / `get<Name>InstructionAsync`,
 * the async form resolving PDAs). What the IDL cannot express is which oracle account
 * a security reads, and which accounts belong to a series; those two helpers live here.
 *
 * All builders return unsigned instructions. Signing and sending is the caller's.
 */
import type { Address } from '@solana/kit';

import {
  findCollateralVaultPda,
  findOptionMintPda,
  findPremiumVaultPda,
  findQuoteVaultPda,
  findSecurityPda,
  type OracleBinding,
  type OracleSource,
} from './generated/index.js';
import { SCOPE_PRICES_ADDRESS } from './oracle.js';

/**
 * The `primary_oracle` / `secondary_oracle` accounts for a binding. Scope sources are all
 * one account. Pyth sources are a `PriceUpdateV2` posted for the transaction, so their
 * address has to be supplied. A single-source binding passes the primary twice, as
 * `ReadSecurity` documents; the program never reads it.
 */
export function oracleAccountsFor(
  binding: OracleBinding,
  pyth: { primary?: Address; secondary?: Address } = {},
): { primaryOracle: Address; secondaryOracle: Address } {
  const resolve = (source: OracleSource, supplied: Address | undefined, role: string): Address => {
    if (source.__kind === 'Scope') return SCOPE_PRICES_ADDRESS;
    if (!supplied) throw new Error(`the ${role} source is Pyth; pass its PriceUpdateV2 account`);
    return supplied;
  };
  const primaryOracle = resolve(binding.primary, pyth.primary, 'primary');
  const secondaryOracle =
    binding.__kind === 'Pair' ? resolve(binding.secondary, pyth.secondary, 'secondary') : primaryOracle;
  return { primaryOracle, secondaryOracle };
}

/** The PDAs `create_series` initialises for a series, and the security it hangs off. */
export async function seriesAccounts(
  series: Address,
  underlyingMint: Address,
  config: { programAddress?: Address } = {},
): Promise<{
  security: Address;
  optionMint: Address;
  collateralVault: Address;
  premiumVault: Address;
  quoteVault: Address;
}> {
  const [[security], [optionMint], [collateralVault], [premiumVault], [quoteVault]] = await Promise.all([
    findSecurityPda({ underlyingMint }, config),
    findOptionMintPda({ series }, config),
    findCollateralVaultPda({ series }, config),
    findPremiumVaultPda({ series }, config),
    findQuoteVaultPda({ series }, config),
  ]);
  return { security, optionMint, collateralVault, premiumVault, quoteVault };
}
