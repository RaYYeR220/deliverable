/**
 * Public configuration. Everything here is inlined into the browser bundle at build
 * time, so nothing secret belongs in this file: the RPC endpoint lives in
 * lib/server/rpc.ts and is read only on the server.
 */

export type Cluster = 'mainnet-beta' | 'devnet' | 'testnet';

const CLUSTERS: readonly Cluster[] = ['mainnet-beta', 'devnet', 'testnet'];

function parseCluster(raw: string | undefined): Cluster {
  const value = raw?.trim();
  return CLUSTERS.find((c) => c === value) ?? 'mainnet-beta';
}

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function parseProgramId(raw: string | undefined): { id: string | null; invalid: string | null } {
  const value = raw?.trim();
  if (!value) return { id: null, invalid: null };
  return BASE58_ADDRESS.test(value) ? { id: value, invalid: null } : { id: null, invalid: value };
}

/** The cluster the program is deployed to. The xStocks and Scope are mainnet facts regardless. */
export const CLUSTER: Cluster = parseCluster(process.env.NEXT_PUBLIC_SOLANA_CLUSTER);

const programId = parseProgramId(process.env.NEXT_PUBLIC_DELIVERABLE_PROGRAM_ID);
/** Null until a deployment is configured; the instrument runs in Preview until then. */
export const PROGRAM_ID: string | null = programId.id;
/** A configured value that is not a base58 address, so the misconfiguration can be shown. */
export const PROGRAM_ID_INVALID: string | null = programId.invalid;

export const REPOSITORY_URL: string | null = process.env.NEXT_PUBLIC_REPOSITORY_URL?.trim() || null;

/**
 * The deployment that exists today is on devnet, against a stand-in mint, because devnet
 * has no xStocks and no Scope. Live then reads that program's own state instead of
 * running the gate over the mainnet securities, which are not registered under it.
 */
export const DEVNET_LIVE: boolean = PROGRAM_ID !== null && CLUSTER === 'devnet';

export const CLUSTER_LABEL: Record<Cluster, string> = {
  'mainnet-beta': 'Solana mainnet',
  devnet: 'Solana devnet',
  testnet: 'Solana testnet',
};

type ExplorerKind = 'tx' | 'account' | 'token';

/** Solscan link. `cluster` defaults to mainnet because most of what is linked lives there. */
export function solscan(kind: ExplorerKind, id: string, cluster: Cluster = 'mainnet-beta'): string {
  const base = `https://solscan.io/${kind}/${id}`;
  return cluster === 'mainnet-beta' ? base : `${base}?cluster=${cluster}`;
}

/** Solana Explorer link. The cluster is carried in the query, as devnet links need it. */
export function explorer(kind: 'tx' | 'address', id: string, cluster: Cluster = CLUSTER): string {
  const base = `https://explorer.solana.com/${kind}/${id}`;
  return cluster === 'mainnet-beta' ? base : `${base}?cluster=${cluster}`;
}

/** The accounts the instrument reads, all on mainnet. */
export const SCOPE_PRICES = '3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH';
export const SCOPE_PROGRAM = 'HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ';

export const SECURITIES = [
  { symbol: 'AAPLx', name: 'Apple xStock', mint: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp' },
  { symbol: 'NVDAx', name: 'NVIDIA xStock', mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh' },
] as const;

export type SecuritySymbol = (typeof SECURITIES)[number]['symbol'];
