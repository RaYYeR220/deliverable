import 'server-only';

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The app reads the repository's own records at build time: the pinned measurements,
 * the keeper's corporate-action history and the mainnet account dumps the tests run on.
 * `next build` runs from app/, so the repository is one level up.
 */
export const REPOSITORY_ROOT = path.resolve(/*turbopackIgnore: true*/ process.cwd(), '..');
export const APP_ROOT = path.resolve(/*turbopackIgnore: true*/ process.cwd());

export function repoPath(...segments: string[]): string {
  return path.join(REPOSITORY_ROOT, ...segments);
}

export function readRepoBytes(...segments: string[]): Uint8Array {
  return new Uint8Array(readFileSync(/*turbopackIgnore: true*/ repoPath(...segments)));
}

export function readRepoJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(/*turbopackIgnore: true*/ repoPath(...segments), 'utf8')) as T;
}

export function readAppBytes(...segments: string[]): Uint8Array {
  return new Uint8Array(readFileSync(path.join(/*turbopackIgnore: true*/ APP_ROOT, ...segments)));
}

export function readAppJson<T>(...segments: string[]): T {
  return JSON.parse(readFileSync(path.join(/*turbopackIgnore: true*/ APP_ROOT, ...segments), 'utf8')) as T;
}
