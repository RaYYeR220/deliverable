import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PublicKey } from "@solana/web3.js";
import { MARKET_DIR, type Cluster } from "./env.ts";

export interface Underlying {
  /** Display ticker of the real-world equity, e.g. "AAPL". */
  ticker: string;
  /** Token symbol of the tokenised share used as the DBC quote mint. */
  quoteSymbol: string;
  quoteMint: PublicKey;
  /** Every xStock is Token-2022 with 8 decimals; verified on chain by verify.ts. */
  quoteDecimals: 8;
  /** Reference spot in USD, only used for moneyness and human-readable output.
   *  Pass --spot to override; the premium itself does not depend on it. */
  referenceSpot: number;
}

/**
 * xStocks mints, Token-2022 on Solana mainnet. Verified live: both carry a DBC
 * token badge, which is what makes them usable as a DBC quote mint.
 */
export const MAINNET_UNDERLYINGS: Record<string, Underlying> = {
  AAPL: {
    ticker: "AAPL",
    quoteSymbol: "AAPLx",
    quoteMint: new PublicKey("XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"),
    quoteDecimals: 8,
    referenceSpot: 335,
  },
  NVDA: {
    ticker: "NVDA",
    quoteSymbol: "NVDAx",
    quoteMint: new PublicKey("Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"),
    quoteDecimals: 8,
    referenceSpot: 222,
  },
};

export const DEVNET_QUOTE_FILE = join(MARKET_DIR, "artifacts", "devnet-quote.json");

export interface DevnetQuoteArtifact {
  mint: string;
  decimals: number;
  symbol: string;
  createdAt: string;
  signature: string;
  note: string;
}

/**
 * Devnet has no xStocks and no xStock token badges (checked: exactly four DBC
 * token badges exist on devnet, none of them an `Xs…` mint). The devnet run
 * therefore uses a locally minted Token-2022 stand-in with the same 8 decimals.
 * See README for exactly which mainnet behaviour that does and does not cover.
 */
export function loadDevnetQuote(): DevnetQuoteArtifact {
  try {
    return JSON.parse(readFileSync(DEVNET_QUOTE_FILE, "utf8")) as DevnetQuoteArtifact;
  } catch {
    throw new Error(
      `No devnet quote mint found at ${DEVNET_QUOTE_FILE}. Run: pnpm run devnet-quote`,
    );
  }
}

export function resolveUnderlying(
  cluster: Cluster,
  ticker: string,
  overrides: { quoteMint?: string; spot?: number } = {},
): Underlying {
  const key = ticker.toUpperCase();

  if (overrides.quoteMint) {
    return {
      ticker: key,
      quoteSymbol: `${key}x`,
      quoteMint: new PublicKey(overrides.quoteMint),
      quoteDecimals: 8,
      referenceSpot: overrides.spot ?? MAINNET_UNDERLYINGS[key]?.referenceSpot ?? 100,
    };
  }

  if (cluster === "devnet") {
    const artifact = loadDevnetQuote();
    if (artifact.decimals !== 8) {
      throw new Error(`Devnet quote mint has ${artifact.decimals} decimals; the curve assumes 8`);
    }
    return {
      ticker: key,
      quoteSymbol: artifact.symbol,
      quoteMint: new PublicKey(artifact.mint),
      quoteDecimals: 8,
      referenceSpot: overrides.spot ?? MAINNET_UNDERLYINGS[key]?.referenceSpot ?? 100,
    };
  }

  const known = MAINNET_UNDERLYINGS[key];
  if (!known) {
    throw new Error(
      `Unknown underlying ${key}. Known: ${Object.keys(MAINNET_UNDERLYINGS).join(", ")}. ` +
        "Pass --quote-mint=<xStock mint> for any other badged xStock.",
    );
  }
  return overrides.spot === undefined ? known : { ...known, referenceSpot: overrides.spot };
}
