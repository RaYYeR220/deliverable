/**
 * Where to talk to, and which program to talk about. Both are configuration: the
 * program is not deployed to any cluster yet, and the id in the IDL is only a default.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { address, type Address } from '@solana/kit';

import { DELIVERABLE_PROGRAM_ADDRESS } from './generated/index.js';

/** sdk/src or sdk/dist -> repository root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function readDotEnv(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[trimmed.slice(0, eq).trim()] = value;
  }
  return out;
}

/**
 * A setting from the process environment, falling back to the repository `.env` and
 * then one in the working directory. Process env always wins.
 */
export function envSetting(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  for (const candidate of [join(REPO_ROOT, '.env'), join(process.cwd(), '.env')]) {
    const value = readDotEnv(candidate)[name];
    if (value) return value;
  }
  return undefined;
}

export function resolveRpcUrl(): string {
  const url = envSetting('SOLANA_RPC_URL');
  if (!url) {
    throw new Error('SOLANA_RPC_URL is not set. Export it, or put it in the repository .env.');
  }
  return url;
}

/** `DELIVERABLE_PROGRAM_ID` when set, otherwise the id the IDL was built with. */
export function resolveProgramAddress(): Address {
  const configured = envSetting('DELIVERABLE_PROGRAM_ID');
  return configured ? address(configured) : DELIVERABLE_PROGRAM_ADDRESS;
}

/** RPC endpoints carry API keys in the path or query, so only the host is ever printable. */
export function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '<unparseable endpoint>';
  }
}
