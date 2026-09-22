/**
 * The names the wheel is allowed to operate on, and the one number the venue cannot
 * observe: the volatility parameter.
 *
 * Mints are the real mainnet xStocks, the same nine the MCP server seeds from
 * (`mcp/src/underlyings.ts`, itself the keeper's verified list). Every one is
 * Token-2022 with 8 decimals.
 *
 * `volAnnual` is a PARAMETER. It is typed by the operator, exactly as
 * `market/src/curve.ts` says: there is no calibration to listed option prices, no
 * surface, no skew and no term structure anywhere in this repository. The wheel
 * therefore never claims a rung is cheap or rich in absolute terms; it reports the
 * volatility at which the quote would exactly clear the hurdle and lets the operator
 * compare that with the parameter they typed. That comparison is the whole decision,
 * and it is honest only because both sides are stated.
 */
import type { Address } from '@solana/kit';

export interface Underlying {
  /** The real-world ticker, e.g. AAPL. */
  ticker: string;
  /** The tokenised share, e.g. AAPLx. */
  symbol: string;
  mint: Address;
  /** Annualised volatility used to price this name's curve. A parameter, not a market. */
  volAnnual: number;
}

const U = (ticker: string, symbol: string, mint: string, volAnnual: number): Underlying => ({
  ticker,
  symbol,
  mint: mint as Address,
  volAnnual,
});

/**
 * Note on coverage: a preview gate binds a security by finding `Checked <SYM>/USD` and
 * `PythLazer <SYM>/USD` in Scope's TokenMetadatas. Six of these nine have both today.
 * NFLXx, CRWDx and KLACx have neither, so `isActionable` cannot preview them and the CLI
 * reports them as not read. They stay in the list because they are the names whose
 * corporate actions the whole adjustment invariant is tested against — NFLXx recorded a
 * ten-for-one split and CRWDx a four-for-one — and because a registered SecurityState
 * can bind a source that Scope does not label.
 */
export const UNDERLYINGS: readonly Underlying[] = Object.freeze([
  U('AAPL', 'AAPLx', 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', 0.28),
  U('NVDA', 'NVDAx', 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', 0.45),
  U('SPY', 'SPYx', 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', 0.16),
  U('QQQ', 'QQQx', 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', 0.2),
  U('META', 'METAx', 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu', 0.35),
  U('NFLX', 'NFLXx', 'XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL', 0.35),
  U('CRWD', 'CRWDx', 'Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw', 0.45),
  U('KLAC', 'KLACx', 'Xsw2uU1i8tHjbgstUbtt3m6kg7BS7AgG5aj8z7ddmmN', 0.4),
  U('STRC', 'STRCx', 'Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH', 0.5),
]);

export function resolveUnderlying(input: string): Underlying {
  const want = input.trim().toLowerCase();
  const hit = UNDERLYINGS.find(
    (u) => u.ticker.toLowerCase() === want || u.symbol.toLowerCase() === want || u.mint.toLowerCase() === want,
  );
  if (!hit) {
    throw new Error(
      `Unknown underlying "${input}". Known: ${UNDERLYINGS.map((u) => u.ticker).join(', ')}. ` +
        'Every one resolves to a real mainnet xStock mint.',
    );
  }
  return hit;
}
