/**
 * The keeper's corporate-action history (keeper/data/corporate-actions.json), read as the
 * keeper writes it. The keeper recovers these by decoding Token-2022 UpdateMultiplier
 * instructions from mainnet; this server only filters them.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The subset of keeper/src/action-history.ts `CorporateAction` this server reads. */
export interface CorporateAction {
  mint: string;
  symbol: string;
  signature: string;
  blockTime: number;
  slot: number;
  newMultiplier: number;
  effectiveTimestamp: number;
  leadTimeSeconds: number;
  previousMultiplier: number | null;
  previousMultiplierSource: string;
  previousEffectiveTimestamp: number | null;
  ratio: number | null;
  percentChange: number | null;
  classification: string | null;
  blockTimeIso: string | null;
  effectiveIso: string | null;
  explorerUrl: string;
}

export interface ActionHistory {
  /** Relative to the repository when it lives inside it, so no local directory leaks into tool output. */
  path: string;
  actions: CorporateAction[];
  error?: string;
}

/** mcp/src or mcp/dist -> repository root. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_ACTIONS_PATH = resolve(REPO_ROOT, 'keeper', 'data', 'corporate-actions.json');

function display(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : path;
}

export function loadActionHistory(path: string = process.env['DELIVERABLE_CORPORATE_ACTIONS'] ?? DEFAULT_ACTIONS_PATH): ActionHistory {
  const shown = display(path);
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed as { actions?: unknown }).actions;
    if (!Array.isArray(list)) return { path: shown, actions: [], error: 'file is not a list of actions' };
    return { path: shown, actions: list as CorporateAction[] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { path: shown, actions: [], error: message.split(path).join(shown) };
  }
}

export interface ActionFilter {
  mint?: string;
  sinceUnix?: number;
  kind?: string;
  limit?: number;
}

/** Newest effective change first. */
export function filterActions(actions: readonly CorporateAction[], filter: ActionFilter): CorporateAction[] {
  return actions
    .filter((a) => (filter.mint ? a.mint === filter.mint : true))
    .filter((a) => (filter.sinceUnix !== undefined ? a.effectiveTimestamp >= filter.sinceUnix : true))
    .filter((a) => (filter.kind ? a.classification === filter.kind : true))
    .sort((a, b) => b.effectiveTimestamp - a.effectiveTimestamp)
    .slice(0, filter.limit ?? 20);
}
