import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { daysFromCivil, easternOffsetSeconds } from '../src/calendar.js';
import { envSetting } from '../src/config.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SDK_ROOT = resolve(HERE, '..');
export const REPO_ROOT = resolve(SDK_ROOT, '..');
export const PROGRAM_SRC = resolve(REPO_ROOT, 'programs', 'deliverable', 'src');

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(resolve(HERE, 'fixtures', name)));
}

export function fixtureJson<T>(name: string): T {
  return JSON.parse(readFileSync(resolve(HERE, 'fixtures', name), 'utf8')) as T;
}

/** A program source file, or null when the SDK is checked out without the program beside it. */
export function programSource(relative: string): string | null {
  const path = resolve(PROGRAM_SRC, relative);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** The same two-pass US Eastern to unix conversion the Rust tests use. */
export function et(year: number, month: number, day: number, hour: number, minute: number): number {
  const local = daysFromCivil(year, month, day) * 86_400 + hour * 3600 + minute * 60;
  return local - easternOffsetSeconds(local + 5 * 3600);
}

export const rpcUrl = envSetting('SOLANA_RPC_URL');
