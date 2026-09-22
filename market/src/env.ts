import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair } from "@solana/web3.js";

const here = dirname(fileURLToPath(import.meta.url));
export const MARKET_DIR = resolve(here, "..");
export const REPO_ROOT = resolve(MARKET_DIR, "..");

export type Cluster = "devnet" | "mainnet";

function readDotEnv(): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(join(REPO_ROOT, ".env"), "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

const dotEnv = readDotEnv();

export function envVar(name: string): string | undefined {
  return process.env[name] ?? dotEnv[name];
}

/**
 * The repo `.env` holds a paid mainnet Helius endpoint. The same key is valid on
 * devnet under a different host, so devnet reuses it instead of hammering the
 * public endpoint (which rate-limits `getProgramAccounts` hard).
 */
export function rpcUrl(cluster: Cluster): string {
  const explicit = envVar(cluster === "devnet" ? "DEVNET_RPC_URL" : "SOLANA_RPC_URL");
  if (cluster === "mainnet") {
    if (!explicit) throw new Error("SOLANA_RPC_URL is not set in the repo .env");
    return explicit;
  }
  if (explicit) return explicit;
  const mainnet = envVar("SOLANA_RPC_URL");
  if (mainnet) {
    try {
      const url = new URL(mainnet);
      if (url.host.includes("helius-rpc.com")) {
        url.host = url.host.replace(/^[^.]+/, "devnet");
        return url.toString();
      }
    } catch {
      // fall through to the public endpoint
    }
  }
  return "https://api.devnet.solana.com";
}

/** Host only. Never log the full URL: it carries the API key in its query string. */
export function rpcHost(cluster: Cluster): string {
  try {
    return new URL(rpcUrl(cluster)).host;
  } catch {
    return "<unparseable>";
  }
}

export function connect(cluster: Cluster): Connection {
  return new Connection(rpcUrl(cluster), "confirmed");
}

export function loadKeypair(path?: string): Keypair {
  const file = path ?? envVar("SOLANA_KEYPAIR") ?? join(homedir(), ".config", "solana", "id.json");
  const bytes = JSON.parse(readFileSync(file, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

/** True when this module is the file node was told to run, so library imports
 *  do not trigger a CLI run. */
export function isEntrypoint(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return metaUrl === new URL(`file://${resolve(entry).replace(/\\/g, "/")}`).href;
}

export interface CliFlags {
  readonly values: ReadonlyMap<string, string>;
  readonly flags: ReadonlySet<string>;
  has(name: string): boolean;
  str(name: string, fallback?: string): string | undefined;
  num(name: string, fallback?: number): number | undefined;
}

export function parseArgs(argv: string[] = process.argv.slice(2)): CliFlags {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) values.set(body.slice(0, eq), body.slice(eq + 1));
    else flags.add(body);
  }
  return {
    values,
    flags,
    has: (name) => flags.has(name) || values.has(name),
    str: (name, fallback) => values.get(name) ?? fallback,
    num: (name, fallback) => {
      const raw = values.get(name);
      if (raw === undefined) return fallback;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed)) throw new Error(`--${name} must be a number, got ${raw}`);
      return parsed;
    },
  };
}

/**
 * Mainnet is gated twice on purpose: pool creation is irreversible and spends real
 * SOL, and the quote side is a real tokenised share.
 */
export function resolveCluster(args: CliFlags): Cluster {
  if (!args.has("mainnet")) return "devnet";
  if (!args.has("yes")) {
    throw new Error("--mainnet requires an explicit --yes. Refusing to touch mainnet.");
  }
  return "mainnet";
}
