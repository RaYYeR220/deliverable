import 'server-only';

import type { LedgerRow } from '@/lib/types';

import { readRepoJson } from './repo';

interface KeeperRecord {
  mint: string;
  symbol: string;
  signature: string;
  blockTime: number;
  slot: number;
  newMultiplier: number;
  effectiveTimestamp: number;
  leadTimeSeconds: number;
  previousMultiplier: number;
  classification: string;
}

export const LEDGER_FILE = 'keeper/data/corporate-actions.json';

/**
 * The hackathon window: 2026-09-11 00:00 UTC to the submission deadline, 2026-09-25 20:00 UTC.
 * Every action that took effect inside it is marked, not a chosen few: the first scan of 28
 * mints found three (STRCx, METAx, QQQx), and the keeper's full history holds more.
 */
export const HACKATHON_WINDOW = { from: Date.UTC(2026, 8, 11) / 1000, to: Date.UTC(2026, 8, 25, 20) / 1000 } as const;
const NAMED_IN_WINDOW = ['STRCx', 'METAx', 'QQQx'] as const;

export function readLedger(): LedgerRow[] {
  const records = readRepoJson<KeeperRecord[]>(...LEDGER_FILE.split('/'));
  const rows = records.map((r) => ({
    symbol: r.symbol,
    mint: r.mint,
    signature: r.signature,
    slot: r.slot,
    blockTime: r.blockTime,
    effectiveTs: r.effectiveTimestamp,
    leadSeconds: r.leadTimeSeconds,
    previous: r.previousMultiplier,
    next: r.newMultiplier,
    classification: r.classification,
    inWindow: r.effectiveTimestamp >= HACKATHON_WINDOW.from && r.effectiveTimestamp <= HACKATHON_WINDOW.to,
  }));
  for (const symbol of NAMED_IN_WINDOW) {
    if (!rows.some((r) => r.symbol === symbol && r.inWindow)) {
      throw new Error(`${symbol} should have an action inside the hackathon window in ${LEDGER_FILE}`);
    }
  }
  return rows.sort((a, b) => b.blockTime - a.blockTime);
}
