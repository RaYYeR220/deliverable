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
