/**
 * Symbol <-> mint resolution, so an agent can say "AAPLx" instead of pasting a mint.
 *
 * The floor is keeper/src/mints.ts's verified seed list; every symbol the keeper's
 * corporate-action history mentions is added on top. A mint address is always accepted
 * as-is, so nothing here limits which mints can be asked about.
 */
import { isAddress, type Address } from '@solana/kit';

import type { CorporateAction } from './actions.js';

/** keeper/src/mints.ts SEED_MINTS, verified live on mainnet. */
const SEED: ReadonlyArray<readonly [string, string]> = [
  ['AAPLx', 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp'],
  ['NVDAx', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh'],
  ['SPYx', 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W'],
  ['QQQx', 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ'],
  ['METAx', 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu'],
  ['NFLXx', 'XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL'],
  ['CRWDx', 'Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw'],
  ['KLACx', 'Xsw2uU1i8tHjbgstUbtt3m6kg7BS7AgG5aj8z7ddmmN'],
  ['STRCx', 'Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH'],
];

export class Underlyings {
  readonly #bySymbol = new Map<string, { symbol: string; mint: Address }>();
  readonly #byMint = new Map<string, string>();

  constructor(actions: readonly CorporateAction[] = []) {
    for (const [symbol, mint] of SEED) this.#add(symbol, mint);
    for (const action of actions) this.#add(action.symbol, action.mint);
  }

  #add(symbol: string, mint: string) {
    if (!isAddress(mint)) return;
    const key = symbol.toLowerCase();
    if (!this.#bySymbol.has(key)) this.#bySymbol.set(key, { symbol, mint });
    if (!this.#byMint.has(mint)) this.#byMint.set(mint, symbol);
  }

  get size(): number {
    return this.#bySymbol.size;
  }

  symbolOf(mint: string): string | null {
    return this.#byMint.get(mint) ?? null;
  }

  /** A mint address, an xStock symbol ("AAPLx"), or the bare ticker ("AAPL"). */
  resolve(input: string): { mint: Address; symbol: string | null } {
    const trimmed = input.trim();
    if (isAddress(trimmed)) return { mint: trimmed, symbol: this.symbolOf(trimmed) };
    const hit = this.#bySymbol.get(trimmed.toLowerCase()) ?? this.#bySymbol.get(`${trimmed.toLowerCase()}x`);
    if (hit) return hit;
    throw new Error(
      `Unknown underlying "${input}". Pass a Token-2022 mint address, or one of: ${[...this.#bySymbol.values()]
        .map((v) => v.symbol)
        .sort()
        .join(', ')}.`,
    );
  }
}
