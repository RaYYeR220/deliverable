import 'server-only';

import { createHash } from 'node:crypto';

import {
  checkActionable,
  decodeMintState,
  decodeScopeLabels,
  DEFAULT_MAX_CONF_BPS,
  DEFAULT_MAX_DIVERGENCE_BPS,
  DEFAULT_MAX_PRICE_AGE_SECS,
  findSecurityPda,
  mintMultiplierAt,
  observe,
  resolveSession,
  SCOPE_PRICES_ADDRESS,
  SCOPE_PROGRAM_ADDRESS,
  scopePairFor,
  US_EQUITY_CALENDAR,
  type OracleBinding,
} from '@stocklana/sdk';

import { CLUSTER, SECURITIES } from '@/lib/config';
import { utc } from '@/lib/format';
import type { BasisView, GateView, PinnedAccount, ReplayData, Sourced } from '@/lib/types';

import { BASIS_FEEDS } from './feeds';
import { buildGateView, labelMap, lastClose } from './gate';
import { readAppBytes, readAppJson, readRepoBytes, readRepoJson } from './repo';
import { PROGRAM_ADDRESS, type Address } from './rpc';

/**
 * Replay: the gate evaluated on account bytes recorded from mainnet, with the clock set to
 * the moment they were recorded. The Scope account and the AAPLx mint are the dumps the
 * program's and the SDK's tests run against (tests/fixtures); the NVDAx mint and Scope's
 * slot labels were pinned into app/data/replay by scripts/capture-replay.mjs. The whole
 * evaluation happens at build time and is identical on every load.
 */

interface CaptureManifest {
  capturedAtSlot: number;
  capturedAtUnix: number;
  accounts: Array<{ file: string; pubkey: string; what: string; bytes: number; sha256: string }>;
}

interface EvidenceFile {
  taken_at: string;
  gap_seconds: number;
  rows: Array<{
    symbol: string;
    oracle_price: number;
    oracle_price_moved: number;
    oracle_ts_advanced_s: number;
    oracle_slot_advanced: number;
    oracle_reported_age_s: number;
    dex_price: number | null;
    basis_bps: number | null;
  }>;
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export const REPLAY_RECORD = 'docs/evidence/weekend-2026-09-20.json';

export async function buildReplay(): Promise<ReplayData> {
  const manifest = readAppJson<CaptureManifest>('data', 'replay', 'manifest.json');
  const pinnedAt = `${utc(manifest.capturedAtUnix)}, slot ${manifest.capturedAtSlot}`;

  const scope = readRepoBytes('tests', 'fixtures', 'scope_prices.bin');
  const labelsBytes = readAppBytes('data', 'replay', 'scope_token_metadatas.bin');
  const labels = decodeScopeLabels(labelsBytes);
  const mintBytes: Record<string, { bytes: Uint8Array; file: string; captured: string }> = {
    AAPLx: { bytes: readRepoBytes('tests', 'fixtures', 'aaplx_mint.bin'), file: 'tests/fixtures/aaplx_mint.bin', captured: '2026-09-20' },
    NVDAx: {
      bytes: readAppBytes('data', 'replay', 'nvdax_mint.bin'),
      file: 'app/data/replay/nvdax_mint.bin',
      captured: pinnedAt,
    },
  };

  const scopeAccount = { address: SCOPE_PRICES_ADDRESS, owner: SCOPE_PROGRAM_ADDRESS, data: scope };

  // One clock for both securities: the latest timestamp on any entry the two bindings read,
  // which is the capture instant as far as the bytes themselves can say. The SDK's own test
  // of this fixture uses the same rule.
  const prepared = SECURITIES.map((security) => {
    const pinned = mintBytes[security.symbol];
    if (!pinned) throw new Error(`no pinned mint for ${security.symbol}`);
    const mintState = decodeMintState(security.mint as Address, pinned.bytes);
    const pair = scopePairFor(labels, security.symbol);
    if (pair.checked === undefined || pair.lazer === undefined) {
      throw new Error(`the pinned Scope labels carry no Checked/PythLazer pair for ${security.symbol}`);
    }
    const binding: OracleBinding = {
      __kind: 'Pair',
      primary: { __kind: 'Scope', index: pair.checked },
      secondary: { __kind: 'Scope', index: pair.lazer },
    };
    return { security, mintState, binding, pinned };
  });

  const stamps = prepared.flatMap(({ binding }) =>
    binding.__kind === 'Pair' ? [observe(binding.primary, scopeAccount, 0n), observe(binding.secondary, scopeAccount, 0n)] : [],
  );
  const clock = stamps.reduce((max, o) => (o.publishTs > max ? o.publishTs : max), 0n);

  const gates = await Promise.all(
    prepared.map(async ({ security, mintState, binding, pinned }) => {
      let result: Sourced<GateView>;
      try {
        if (binding.__kind !== 'Pair') throw new Error('unreachable');
        if (!mintState.scaledUiAmount) throw new Error(`${security.symbol} has no ScaledUiAmount extension`);
        const primary = observe(binding.primary, scopeAccount, clock);
        const secondary = observe(binding.secondary, scopeAccount, clock);
        const tolerances = {
          maxAge: DEFAULT_MAX_PRICE_AGE_SECS,
          maxConfBps: DEFAULT_MAX_CONF_BPS,
          maxDivergenceBps: DEFAULT_MAX_DIVERGENCE_BPS,
        };
        const verdict = checkActionable({
          now: clock,
          calendar: US_EQUITY_CALENDAR,
          halt: { halted: false },
          mintPaused: mintState.paused,
          transferHook: mintState.transferHookProgramId,
          multiplier: mintMultiplierAt(mintState.scaledUiAmount, clock),
          primarySource: binding.primary,
          primary,
          secondary: { source: binding.secondary, observation: secondary },
          ...tolerances,
        });
        const [securityPda] = await findSecurityPda({ underlyingMint: security.mint as Address }, { programAddress: PROGRAM_ADDRESS });
        result = {
          ok: true,
          value: buildGateView({
            symbol: security.symbol,
            name: security.name,
            mint: security.mint,
            basis: 'preview',
            programId: PROGRAM_ADDRESS,
            security: securityPda,
            cluster: CLUSTER,
            now: clock,
            calendar: US_EQUITY_CALENDAR,
            halt: null,
            mintState,
            binding,
            primary,
            secondary,
            labels: labelMap(labels),
            tolerances,
            verdict,
            notes: [
              `Mint: ${pinned.file}, captured ${pinned.captured}.`,
              'Scope OraclePrices: tests/fixtures/scope_prices.bin, the account the program tests run against.',
              `Clock: ${utc(Number(clock))}, the latest timestamp on the entries this security is bound to.`,
              'Calendar, tolerances and binding are the preview terms: the committed US equity schedule, the program defaults and the conventional Checked-against-PythLazer pair.',
            ],
            registryPaused: null,
          }),
        };
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return { symbol: security.symbol, mint: security.mint, result };
    }),
  );

  const accounts: PinnedAccount[] = [
    {
      what: 'Kamino Scope OraclePrices',
      pubkey: SCOPE_PRICES_ADDRESS,
      file: 'tests/fixtures/scope_prices.bin',
      captured: `2026-09-20; the entries read are stamped ${utc(Number(clock))}`,
      sha256: sha256(scope),
    },
    ...prepared.map(({ security, pinned }) => ({
      what: `${security.symbol} Token-2022 mint`,
      pubkey: security.mint,
      file: pinned.file,
      captured: pinned.captured,
      sha256: sha256(pinned.bytes),
    })),
    {
      what: 'Scope TokenMetadatas (slot labels)',
      pubkey: manifest.accounts.find((a) => a.file === 'scope_token_metadatas.bin')?.pubkey ?? '',
      file: 'app/data/replay/scope_token_metadatas.bin',
      captured: pinnedAt,
      sha256: sha256(labelsBytes),
    },
  ];

  return { clock: Number(clock), gates, basis: pinnedBasis(labelMap(labels)), accounts };
}

function pinnedBasis(labels: ReadonlyMap<number, string>): Sourced<BasisView> {
  try {
    const evidence = readRepoJson<EvidenceFile>(...REPLAY_RECORD.split('/'));
    const at = Math.floor(Date.parse(evidence.taken_at) / 1000);
    const rows = evidence.rows.map((row) => {
      const feed = BASIS_FEEDS.find((f) => f.symbol === row.symbol);
      if (!feed) throw new Error(`${row.symbol} is not one of the sampled feeds`);
      return {
        symbol: row.symbol,
        mint: feed.mint,
        scopeIndex: feed.index,
        scopeLabel: labels.get(feed.index) ?? null,
        oraclePrice: row.oracle_price,
        oracleTs: at - row.oracle_reported_age_s,
        oracleSlot: null,
        reportedAge: row.oracle_reported_age_s,
        marketPrice: row.dex_price,
        basisBps: row.basis_bps,
        moved: row.oracle_price_moved,
        tsAdvanced: row.oracle_ts_advanced_s,
        slotAdvanced: row.oracle_slot_advanced,
      };
    });
    return {
      ok: true,
      value: {
        source: 'pinned',
        at,
        slot: null,
        session: resolveSession(US_EQUITY_CALENDAR, at),
        lastClose: lastClose(US_EQUITY_CALENDAR, at),
        rows,
        market: { ok: true, error: null, source: 'jup.ag price v3' },
        gapSeconds: evidence.gap_seconds,
        record: REPLAY_RECORD,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
