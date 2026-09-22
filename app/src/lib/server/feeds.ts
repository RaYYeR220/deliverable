import 'server-only';

/**
 * The Scope entries scripts/measure-basis.py samples, index for index, so a live reading
 * here and a pinned one in docs/evidence measure the same thing. The script cross-checked
 * each slot against the Kamino lending reserve that consumes it; the instrument shows the
 * label Scope itself gives each slot beside the number.
 */
export const BASIS_FEEDS = [
  { index: 317, symbol: 'AAPLx', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp' },
  { index: 332, symbol: 'NVDAx', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' },
  { index: 342, symbol: 'SPYx', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' },
  { index: 345, symbol: 'QQQx', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ' },
  { index: 327, symbol: 'METAx', mint: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu' },
  { index: 323, symbol: 'CRCLx', mint: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1' },
  { index: 320, symbol: 'HOODx', mint: 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg' },
  { index: 341, symbol: 'COINx', mint: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu' },
] as const;

export const JUPITER_PRICE_V3 = 'https://lite-api.jup.ag/price/v3';

/**
 * Units. A Scope xStock entry prices one unscaled token (raw / 10^decimals); jup.ag's
 * `usdPrice` prices one share, the UI unit, which is raw x the mint's ScaledUiAmount
 * multiplier. Like for like, the oracle's price per share is `scope / multiplier`, and the
 * basis is (market - oracle per share) / oracle per share. Comparing the two bare numbers
 * is off by exactly the multiplier.
 */
export function perShareBasis(oraclePrice: number, multiplier: number, marketPrice: number | null) {
  const oraclePerShare = oraclePrice / multiplier;
  return {
    oraclePerShare,
    basisBps: marketPrice === null ? null : ((marketPrice - oraclePerShare) / oraclePerShare) * 10_000,
    basisBareBps: marketPrice === null ? null : ((marketPrice - oraclePrice) / oraclePrice) * 10_000,
  };
}

/**
 * The multiplier in force at each pinned read (2026-09-20 09:15 UTC and 2026-09-22 08:11 UTC),
 * for recomputing the pinned records like for like. The files carry prices, not multipliers.
 * Each value is the mint's `newMultiplier` as read on 2026-09-22; every one of them took
 * effect before 2026-09-20 09:15 UTC (the latest, QQQx, at 2026-09-19 23:00 UTC) and no change
 * was scheduled at the read, so the same value was in force at both pinned reads. CRCLx, HOODx
 * and COINx carry 1.0 in both fields, with an effective timestamp of 0.
 */
export const PINNED_MULTIPLIERS: Readonly<Record<string, number>> = {
  AAPLx: 1.0032690125398187,
  NVDAx: 1.001701196801074,
  SPYx: 1.005714560286254,
  QQQx: 1.0034560758968376,
  METAx: 1.0028515433272898,
  CRCLx: 1,
  HOODx: 1,
  COINx: 1,
};
