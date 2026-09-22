import 'server-only';

import { formatFixed, refusalInfo, type OracleBinding, type OracleSource, type SecurityStateView } from '@stocklana/sdk';

import { refusalTitle, roman } from '@/lib/format';
import type { DevnetProbe, DevnetRecord, DevnetState } from '@/lib/types';

import deploymentJson from '../../../../scripts/devnet/deployment.json';
import { devnetDeliverable, PROGRAM_ADDRESS, SourceUnavailable, type Address } from './rpc';

/**
 * Live against the devnet deployment.
 *
 * Devnet has the Pyth receiver but no xStocks mint and no Kamino Scope account, so the
 * security registered there is a Token-2022 stand-in carrying AAPLx's extension set,
 * bound to Pyth alone. Everything in DevnetState is read from the program's own
 * accounts through the SDK; everything in DevnetRecord comes from the repository's
 * deployment record and is marked as such wherever it is shown.
 */

export const DEPLOYMENT_FILE = 'scripts/devnet/deployment.json';

interface DeploymentFile {
  cluster?: string;
  programId?: string;
  registry?: string;
  calendar?: string;
  standinMint?: string;
  security?: string;
  deploy?: { signature?: string; slot?: number };
  binding?: { kind?: string; primary?: { kind?: string; feed?: string; feedId?: string; maxAge?: number } };
  probes?: Array<{
    mode?: string;
    session?: string;
    chainClock?: number;
    code?: number;
    refusalsAfter?: number;
    signatures?: Array<{ label?: string; signature?: string }>;
  }>;
}

const DEPLOYMENT = deploymentJson as unknown as DeploymentFile;

/** The stand-in the program is registered against on devnet. */
export const STANDIN_MINT: string | null = DEPLOYMENT.standinMint ?? null;

const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** `34243997`, expo −5 → `342.43997`. The value as read, placed by its own exponent. */
function decimal(value: bigint, expo: number): string {
  if (expo >= 0) return (value * 10n ** BigInt(expo)).toString();
  const places = -expo;
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  return `${negative ? '−' : ''}${whole}.${digits.slice(digits.length - places)}`;
}

function sourceText(source: OracleSource): string {
  return source.__kind === 'Scope' ? `Scope #${source.index}` : `Pyth feed 0x${hex(source.feedId)}`;
}

function bindingView(binding: OracleBinding): DevnetState['binding'] {
  const primary = binding.primary;
  const feedId = primary.__kind === 'Pyth' ? hex(primary.feedId) : null;
  const recorded = DEPLOYMENT.binding?.primary;
  // The feed's name is not on chain: it is only shown when the id read back from the
  // security is the one the deployment record registered under that name.
  const recordedId = recorded?.feedId?.replace(/^0x/, '').toLowerCase() ?? null;
  const feedName = feedId !== null && recordedId === feedId ? (recorded?.feed ?? null) : null;
  return {
    kind: binding.__kind,
    source: sourceText(primary),
    feedId,
    maxAge: primary.__kind === 'Pyth' ? primary.maxAge : null,
    feedName,
    secondary: binding.__kind === 'Pair' ? sourceText(binding.secondary) : null,
  };
}

/** The deployment record, as committed. Read at build time and shown as a record, not a reading. */
export function devnetRecord(): DevnetRecord {
  const probes: DevnetProbe[] = (DEPLOYMENT.probes ?? []).map((probe) => {
    const info = typeof probe.code === 'number' ? refusalInfo(probe.code) : undefined;
    return {
      mode: probe.mode ?? 'unknown',
      session: probe.session ?? null,
      chainClock: typeof probe.chainClock === 'number' ? probe.chainClock : null,
      code: typeof probe.code === 'number' ? probe.code : null,
      codeName: info?.name ?? null,
      refusalsAfter: typeof probe.refusalsAfter === 'number' ? probe.refusalsAfter : null,
      signatures: (probe.signatures ?? [])
        .filter((s): s is { label?: string; signature: string } => typeof s.signature === 'string')
        .map((s) => ({ label: s.label ?? 'transaction', signature: s.signature })),
    };
  });

  const recorded = DEPLOYMENT.binding?.primary;
  return {
    programId: DEPLOYMENT.programId ?? PROGRAM_ADDRESS,
    standinMint: DEPLOYMENT.standinMint ?? '',
    security: DEPLOYMENT.security ?? '',
    registry: DEPLOYMENT.registry ?? '',
    calendar: DEPLOYMENT.calendar ?? '',
    deploySignature: DEPLOYMENT.deploy?.signature ?? null,
    deploySlot: typeof DEPLOYMENT.deploy?.slot === 'number' ? DEPLOYMENT.deploy.slot : null,
    feed:
      recorded?.feed && recorded.feedId
        ? { name: recorded.feed, id: recorded.feedId, maxAge: recorded.maxAge ?? 0 }
        : null,
    probes,
    file: DEPLOYMENT_FILE,
  };
}

function priceView(state: SecurityStateView, now: bigint): DevnetState['price'] {
  const o = state.primary;
  if (o.publishTs === 0n) return null;
  // The program compares an integer bps; the band is printed to three places so a
  // sub-bps band is not rounded away into "0 bps".
  const band = o.price > 0n ? ((Number(o.conf) / Number(o.price)) * 10_000).toFixed(3) : '—';
  return {
    text: decimal(o.price, o.expo),
    conf: decimal(o.conf, o.expo),
    confBps: band,
    expo: o.expo,
    publishTs: Number(o.publishTs),
    age: Number(now - o.publishTs),
  };
}

/** The deployed program's own state, read from devnet now. */
export async function readDevnetState(): Promise<DevnetState> {
  if (!STANDIN_MINT) {
    throw new SourceUnavailable(`${DEPLOYMENT_FILE} records no devnet security, so there is nothing to read.`);
  }
  const d = devnetDeliverable();
  const mint = STANDIN_MINT as Address;

  const [deployed, state, mintState, registry, now] = await Promise.all([
    d.programDeployed(),
    d.getSecurityState(mint),
    d.getMint(mint),
    d.getRegistry(),
    d.chainTime(),
  ]);
  if (!deployed) throw new SourceUnavailable(`No executable program at ${PROGRAM_ADDRESS} on devnet.`);
  if (!state) throw new SourceUnavailable(`No SecurityState for ${mint} under ${PROGRAM_ADDRESS} on devnet.`);

  const info = refusalInfo(state.lastRefusalCode);
  return {
    programId: PROGRAM_ADDRESS,
    security: state.address,
    mint,
    symbol: state.symbolText,
    decimals: state.decimals,
    mintSymbol: mintState.symbol,
    mintName: mintState.name,
    mintSupply: mintState.supply.toString(),
    binding: bindingView(state.sources),
    price: priceView(state, now),
    syncedTs: Number(state.syncedTs),
    observedMultiplier: formatFixed(state.observedMultiplier),
    pendingMultiplier: state.pendingMultiplier > 0n ? formatFixed(state.pendingMultiplier) : null,
    refusals: state.refusals,
    lastRefusalCode: state.lastRefusalCode,
    lastRefusalName: info?.name ?? null,
    lastRefusalTitle: info ? refusalTitle(info.name) : null,
    lastRefusalNumeral: info ? roman(info.code) : null,
    lastRefusalErrorCode: info?.errorCode ?? null,
    lastRefusalReason: info?.explanation ?? null,
    lastRefusalTs: Number(state.lastRefusalTs),
    tolerances: { maxAge: state.maxPriceAge, maxConfBps: state.maxConfBps, maxDivergenceBps: state.maxDivergenceBps },
    halted: state.halt.halted,
    registryPaused: registry ? registry.paused : null,
    chainClock: Number(now),
  };
}
