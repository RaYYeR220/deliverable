import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface XStock {
  mint: string;
  symbol: string;
}

/**
 * Verified live on mainnet. This is the floor: the richer registry below is loaded on top
 * when it is present, but the tool must still run from a bare checkout.
 */
export const SEED_MINTS: XStock[] = [
  { symbol: 'AAPLx', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp' },
  { symbol: 'NVDAx', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' },
  { symbol: 'SPYx', mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W' },
  { symbol: 'QQQx', mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ' },
  { symbol: 'METAx', mint: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu' },
  { symbol: 'NFLXx', mint: 'XsEH7wWfJJu2ZT3UCFeVfALnVA6CP5ur7Ee11KmzVpL' },
  { symbol: 'CRWDx', mint: 'Xs7xXqkcK7K8urEqGg52SECi79dRp2cEKKuYjUePYDw' },
  { symbol: 'KLACx', mint: 'Xsw2uU1i8tHjbgstUbtt3m6kg7BS7AgG5aj8z7ddmmN' },
  { symbol: 'STRCx', mint: 'Xs78JED6PFZxWc2wCEPspZW9kL3Se5J7L5TChKgsidH' },
];

/** The ScaledUiAmount multiplier authority shared by every xStock mint. */
export const MULTIPLIER_AUTHORITY = 'S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS';

const REGISTRY_CANDIDATES = [
  resolve(HERE, '..', '..', '..', '_internal', 'xstocks_mints.json'),
  resolve(HERE, '..', '..', '_internal', 'xstocks_mints.json'),
  resolve(HERE, '..', 'data', 'xstocks_mints.json'),
];

function parseRegistry(raw: string): XStock[] {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') return [];

  // Accepts either { mint: { symbol } } or [{ mint, symbol }].
  if (Array.isArray(parsed)) {
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') return [];
      const { mint, symbol } = entry as Record<string, unknown>;
      return typeof mint === 'string' && typeof symbol === 'string' ? [{ mint, symbol }] : [];
    });
  }

  return Object.entries(parsed as Record<string, unknown>).flatMap(([mint, value]) => {
    if (!value || typeof value !== 'object') return [];
    const symbol = (value as Record<string, unknown>)['symbol'];
    return typeof symbol === 'string' ? [{ mint, symbol }] : [];
  });
}

export interface MintRegistry {
  mints: XStock[];
  source: string;
}

/**
 * `XSTOCKS_MINTS` is an exact override and is used verbatim. Otherwise the internal registry is
 * discovered and topped up with any seed mint it happens to be missing, falling back to the
 * seeds alone.
 */
export function loadMints(): MintRegistry {
  const override = process.env['XSTOCKS_MINTS'];
  if (override) {
    const mints = readRegistry(override);
    if (mints) return { mints, source: override };
    throw new Error(`XSTOCKS_MINTS points at ${override}, which could not be read as a mint registry`);
  }

  for (const path of REGISTRY_CANDIDATES) {
    const mints = readRegistry(path);
    if (mints) return { mints: merge(mints), source: path };
  }

  return { mints: SEED_MINTS, source: 'built-in seed list' };
}

function readRegistry(path: string): XStock[] | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const mints = parseRegistry(raw);
    return mints.length > 0 ? mints : null;
  } catch {
    return null;
  }
}

function merge(loaded: XStock[]): XStock[] {
  const byMint = new Map(loaded.map((entry) => [entry.mint, entry]));
  for (const seed of SEED_MINTS) if (!byMint.has(seed.mint)) byMint.set(seed.mint, seed);
  return [...byMint.values()];
}
