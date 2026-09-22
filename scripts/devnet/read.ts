// Read the whole devnet deployment back from chain.
//
//   pnpm tsx read.ts
//
// Program, registry, calendar, the stand-in mint with every Token-2022
// extension decoded, the SecurityState including its refusal ledger and the
// Pyth observation it recorded, and each posted PriceUpdateV2.

import {
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getDefaultAccountState,
  getExtensionTypes,
  getMetadataPointerState,
  getMint,
  getPausableConfig,
  getPermanentDelegate,
  getScaledUiAmountConfig,
  getTokenMetadata,
  getTransferHook,
} from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

import {
  PROGRAM_ID,
  REFUSAL_NAMES,
  calendarPda,
  connection,
  decodeCalendar,
  decodePriceUpdateV2,
  decodeRegistry,
  decodeSecurityState,
  explorer,
  fmtFixed,
  readDeployment,
  registryPda,
  rpcHost,
  securityPda,
} from './lib.ts';

const BPF_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

async function main() {
  const conn = connection();
  const d = readDeployment();
  console.log(`rpc ${rpcHost()}\n`);

  const program = await conn.getAccountInfo(PROGRAM_ID);
  const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], BPF_UPGRADEABLE)[0];
  const pd = await conn.getAccountInfo(programData);
  console.log(`Program ${PROGRAM_ID.toBase58()}  executable ${program?.executable}  owner ${program?.owner.toBase58()}`);
  console.log(`  programdata ${programData.toBase58()}  ${pd ? `${pd.data.length - 45} bytes of program` : 'missing'}`);
  console.log(`  ${explorer('address', PROGRAM_ID.toBase58())}`);

  const reg = decodeRegistry((await conn.getAccountInfo(registryPda()))!.data);
  console.log(`\nRegistry ${registryPda().toBase58()}`);
  console.log(`  authority ${reg.authority.toBase58()}  attestor ${reg.attestor.toBase58()}  paused ${reg.paused}`);

  const cal = decodeCalendar((await conn.getAccountInfo(calendarPda(0)))!.data);
  console.log(`\nCalendar ${calendarPda(0).toBase58()}`);
  console.log(`  id ${cal.id}  version ${cal.version}  regular ${cal.regularOpenMinute}-${cal.regularCloseMinute} min ET  entries ${cal.entries.length}`);

  if (typeof d.standinMint !== 'string') return;
  const mint = new PublicKey(d.standinMint);
  const m = await getMint(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  console.log(`\nStand-in mint ${mint.toBase58()}  (AAPLx devnet stand-in, NOT an xStock)`);
  console.log(`  decimals ${m.decimals}  supply ${m.supply}  mint authority ${m.mintAuthority?.toBase58()}  freeze authority ${m.freezeAuthority?.toBase58()}`);
  console.log(`  extensions: ${getExtensionTypes(m.tlvData).map((t) => ExtensionType[t]).join(', ')}`);
  const scaled = getScaledUiAmountConfig(m);
  console.log(
    `  ScaledUiAmount: authority ${scaled?.authority.toBase58()} multiplier ${scaled?.multiplier} new_multiplier ${scaled?.newMultiplier} effective_ts ${scaled?.newMultiplierEffectiveTimestamp}`,
  );
  const pausable = getPausableConfig(m);
  console.log(`  Pausable: authority ${pausable?.authority.toBase58()} paused ${pausable?.paused}`);
  const hook = getTransferHook(m);
  console.log(
    `  TransferHook: authority ${hook?.authority.toBase58()} program_id ${hook?.programId.equals(PublicKey.default) ? 'null' : hook?.programId.toBase58()}`,
  );
  console.log(`  PermanentDelegate: ${getPermanentDelegate(m)?.delegate.toBase58()}`);
  console.log(`  DefaultAccountState: ${getDefaultAccountState(m)?.state === 1 ? 'Initialized' : getDefaultAccountState(m)?.state}`);
  const mp = getMetadataPointerState(m);
  console.log(`  MetadataPointer: authority ${mp?.authority?.toBase58()} metadata ${mp?.metadataAddress?.toBase58()}`);
  const meta = await getTokenMetadata(conn, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  console.log(`  TokenMetadata: name "${meta?.name}" symbol "${meta?.symbol}" uri "${meta?.uri}"`);
  for (const [k, v] of meta?.additionalMetadata ?? []) console.log(`    ${k}: ${v}`);

  const security = securityPda(mint);
  const s = decodeSecurityState((await conn.getAccountInfo(security))!.data);
  console.log(`\nSecurityState ${security.toBase58()}`);
  console.log(`  symbol ${s.symbol}  calendar ${s.calendarId}  decimals ${s.decimals}`);
  if (s.sources.kind === 'SingleDeclared' && s.sources.primary.kind === 'Pyth') {
    console.log(`  sources SingleDeclared { Pyth feed 0x${s.sources.primary.feedId.toString('hex')} max_age ${s.sources.primary.maxAge} }`);
  } else {
    console.log(`  sources ${JSON.stringify(s.sources)}`);
  }
  console.log(`  observed_multiplier ${fmtFixed(s.observedMultiplier, -12)}  pending ${s.pendingMultiplier}  epoch ${s.multiplierEpoch}`);
  console.log(`  mint_paused ${s.mintPaused}  transfer_hook ${s.transferHook?.toBase58() ?? 'null'}  halted ${s.halt.halted}`);
  console.log(`  max_price_age ${s.maxPriceAge}s  max_conf_bps ${s.maxConfBps}  max_divergence_bps ${s.maxDivergenceBps}`);
  console.log(
    `  primary (last sync): price ${fmtFixed(s.primary.price, s.primary.expo)} conf ${fmtFixed(s.primary.conf, s.primary.expo)} expo ${s.primary.expo} publish_ts ${s.primary.publishTs}`,
  );
  if (s.primary.price > 0n) {
    const bps = Number((s.primary.conf * 10_000_000n) / BigInt(s.primary.price)) / 1000;
    console.log(`    confidence ${bps} bps of price (bound ${s.maxConfBps} bps)`);
  }
  console.log(`  secondary ${s.secondary ? JSON.stringify(s.secondary) : 'none'}  synced_ts ${s.syncedTs}`);
  console.log(`  refusals ${s.refusals}`);
  console.log(`  last_refusal_code ${s.lastRefusalCode} (${REFUSAL_NAMES[s.lastRefusalCode] ?? 'none'})`);
  console.log(`  last_refusal_ts ${s.lastRefusalTs} (${new Date(Number(s.lastRefusalTs) * 1000).toISOString()})`);

  const probes = (d.probes as { priceUpdateAccount?: string }[] | undefined) ?? [];
  for (const addr of new Set(probes.map((p) => p.priceUpdateAccount).filter(Boolean) as string[])) {
    const info = await conn.getAccountInfo(new PublicKey(addr));
    if (!info) {
      console.log(`\nPriceUpdateV2 ${addr}: closed`);
      continue;
    }
    const u = decodePriceUpdateV2(info.data);
    console.log(`\nPriceUpdateV2 ${addr}  owner ${info.owner.toBase58()}`);
    console.log(`  feed 0x${u.feedId}  verification ${u.verificationLevel}`);
    console.log(
      `  price ${fmtFixed(u.price, u.exponent)} conf ${fmtFixed(u.conf, u.exponent)} publish_time ${u.publishTime} (${new Date(Number(u.publishTime) * 1000).toISOString()}) posted_slot ${u.postedSlot}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
