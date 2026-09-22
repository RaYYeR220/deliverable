// Step 4: ask the gate for its verdict on devnet, against a real Pyth update.
//
//   pnpm tsx probe.ts            # picks the mode from the chain clock
//   pnpm tsx probe.ts --open     # force the in-session flow
//   pnpm tsx probe.ts --closed   # force the closed-session flow
//
// In session: fetch the latest Equity.US.AAPL/USD update from Hermes (API key
// from PYTH_API_KEY, sent as a Bearer token), post it through the Pyth Solana
// Receiver with full Wormhole verification, and in the transaction that posts
// it call `sync_security` (records Pyth's price and confidence on the
// SecurityState) and `probe_security` (records the gate's verdict). The update
// and encoded-VAA accounts are left open so they can be inspected afterwards.
// Expected verdict: SingleSource (9), after staleness and confidence have
// passed on the real update.
//
// Closed session: `probe_security` alone. The calendar decides before any
// oracle is read, so the oracle slot is given the last posted update, which is
// never touched. Expected verdict: MarketClosed (1).

import { HermesClient } from '@pythnetwork/hermes-client';
import { PythSolanaReceiver } from '@pythnetwork/pyth-solana-receiver';
import {
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  Transaction,
  VersionedTransaction,
  type Connection,
  type Keypair,
} from '@solana/web3.js';

import {
  AAPL_FEED,
  HERMES_URL,
  PROGRAM_ID,
  PYTH_API_KEY,
  PYTH_RECEIVER,
  REFUSAL_NAMES,
  US_EQUITY_CALENDAR_ID,
  calendarPda,
  connection,
  decodeCalendar,
  decodePriceUpdateV2,
  decodeSecurityState,
  explorer,
  fmtFixed,
  parseEvents,
  probeSecurityIx,
  readDeployment,
  recordTx,
  rpcHost,
  securityPda,
  send,
  syncSecurityIx,
  wallet,
  writeDeployment,
} from './lib.ts';

// --- session, ported from calendar.rs for the log line only -----------------
// The program decides the session itself; this is here so the script can say
// which flow it is about to run and why.

const DAY = 86_400;
function civilFromDays(z0: number): [number, number, number] {
  const z = z0 + 719_468;
  const era = Math.floor((z >= 0 ? z : z - 146_096) / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [y + (m <= 2 ? 1 : 0), m, d];
}
function nthSunday(year: number, month: number, n: number): number {
  const first = Date.UTC(year, month - 1, 1) / 1000 / DAY;
  const wd = (((first + 4) % 7) + 7) % 7;
  return first + ((7 - wd) % 7) + (n - 1) * 7;
}
function easternOffset(ts: number): number {
  const [year] = civilFromDays(Math.floor(ts / DAY));
  const start = nthSunday(year, 3, 2) * DAY + 7 * 3600;
  const end = nthSunday(year, 11, 1) * DAY + 6 * 3600;
  return ts >= start && ts < end ? -4 * 3600 : -5 * 3600;
}
function sessionAt(cal: ReturnType<typeof decodeCalendar>, ts: number): 'Regular' | 'Closed' {
  const local = ts + easternOffset(ts);
  const days = Math.floor(local / DAY);
  const wd = (((days + 4) % 7) + 7) % 7;
  if (wd === 0 || wd === 6) return 'Closed';
  const [, m, d] = civilFromDays(days);
  const entry = cal.entries.find((e) => e.dateKey === ((m << 8) | d));
  if (entry && entry.kind === 0) return 'Closed';
  const close = entry ? entry.closeMinute : cal.regularCloseMinute;
  const minute = Math.floor((((local % DAY) + DAY) % DAY) / 60);
  return minute >= cal.regularOpenMinute && minute < close ? 'Regular' : 'Closed';
}

// --- helpers ------------------------------------------------------------------

async function chainClock(conn: Connection): Promise<number> {
  const info = await conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY);
  return Number(info!.data.readBigInt64LE(32));
}

/** The receiver SDK wants an Anchor wallet; only these members are used. */
function anchorWallet(payer: Keypair) {
  return {
    payer,
    publicKey: payer.publicKey,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      if (tx instanceof VersionedTransaction) tx.sign([payer]);
      else tx.partialSign(payer);
      return tx;
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      for (const tx of txs) await this.signTransaction(tx);
      return txs;
    },
  };
}

function describeTx(tx: VersionedTransaction): string {
  const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
  const programs = tx.message.compiledInstructions.map((ci) => keys[ci.programIdIndex]);
  const has = (p: PublicKey) => programs.includes(p.toBase58());
  if (has(PROGRAM_ID)) return 'pyth post_update + sync_security + probe_security';
  if (has(PYTH_RECEIVER)) return 'pyth post_update';
  return 'wormhole encoded VAA (init, write, verify)';
}

async function readSecurity(conn: Connection, mint: PublicKey) {
  return decodeSecurityState((await conn.getAccountInfo(securityPda(mint)))!.data);
}

function printVerdict(logs: string[]) {
  const events = parseEvents(logs);
  for (const e of events) {
    if (e.name === 'Refused') {
      const code = e.fields.code as number;
      console.log(`  Refused event: code ${code} ${REFUSAL_NAMES[code]} at ${e.fields.at}`);
    } else if (e.name === 'SecuritySynced') {
      console.log(
        `  SecuritySynced event: price ${e.fields.price} expo ${e.fields.expo} publish_ts ${e.fields.publishTs} at ${e.fields.at}`,
      );
    }
  }
  for (const l of logs.filter((l) => /refused code=|actionable at/.test(l))) console.log(`  log: ${l}`);
  return events.find((e) => e.name === 'Refused')?.fields.code as number | undefined;
}

// --- flows --------------------------------------------------------------------

async function inSession(conn: Connection, payer: Keypair, mint: PublicKey) {
  if (!PYTH_API_KEY) throw new Error('PYTH_API_KEY is not set (repo .env or environment)');
  const hermes = new HermesClient(HERMES_URL, { accessToken: PYTH_API_KEY });
  const update = await hermes.getLatestPriceUpdates([AAPL_FEED], { encoding: 'base64', parsed: true });
  const parsed = update.parsed?.[0];
  if (!parsed) throw new Error('Hermes returned no parsed AAPL update');
  const nowWall = Math.floor(Date.now() / 1000);
  const p = parsed.price;
  console.log(`Hermes ${HERMES_URL} Equity.US.AAPL/USD`);
  console.log(
    `  price ${fmtFixed(BigInt(p.price), p.expo)} conf ${fmtFixed(BigInt(p.conf), p.expo)} publish_time ${p.publish_time} (${nowWall - p.publish_time}s old by wall clock)`,
  );

  const receiver = new PythSolanaReceiver({ connection: conn, wallet: anchorWallet(payer) as never });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: false });
  await builder.addPostPriceUpdates(update.binary.data);
  const priceUpdate = builder.getPriceUpdateAccount(AAPL_FEED);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount) => [
    { instruction: syncSecurityIx(mint, getPriceUpdateAccount(AAPL_FEED)), signers: [], computeUnits: 120_000 },
    {
      instruction: probeSecurityIx(mint, US_EQUITY_CALENDAR_ID, getPriceUpdateAccount(AAPL_FEED)),
      signers: [],
      computeUnits: 120_000,
    },
  ]);
  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 20_000 });
  console.log(`posting through the Pyth receiver in ${txs.length} transactions; update account ${priceUpdate.toBase58()}`);

  const signatures: { label: string; signature: string; createdAccounts: string[] }[] = [];
  let finalLogs: string[] = [];
  for (const [i, { tx, signers }] of txs.entries()) {
    tx.sign([payer, ...signers]);
    const label = `${describeTx(tx)} [${i + 1}/${txs.length}]`;
    const signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    const bh = await conn.getLatestBlockhash('confirmed');
    const res = await conn.confirmTransaction({ signature, ...bh }, 'confirmed');
    if (res.value.err) throw new Error(`${label} failed: ${JSON.stringify(res.value.err)} (${signature})`);
    const info = await conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (info?.meta?.err) throw new Error(`${label} failed: ${JSON.stringify(info.meta.err)} (${signature})`);
    recordTx(`probe(open): ${label}`, signature, info?.slot, info?.blockTime);
    // Ephemeral signers are the accounts this transaction creates: the encoded
    // VAA in the first one, the PriceUpdateV2 in the one that posts.
    signatures.push({ label, signature, createdAccounts: signers.map((s) => s.publicKey.toBase58()) });
    console.log(`${label}: ${signature}`);
    console.log(`  ${explorer('tx', signature)}`);
    if (describeTx(tx).includes('probe_security')) finalLogs = info?.meta?.logMessages ?? [];
  }

  const code = printVerdict(finalLogs);
  const onchain = decodePriceUpdateV2((await conn.getAccountInfo(priceUpdate))!.data);
  console.log(`PriceUpdateV2 ${priceUpdate.toBase58()} (${onchain.verificationLevel} verification)`);
  console.log(
    `  price ${fmtFixed(onchain.price, onchain.exponent)} conf ${fmtFixed(onchain.conf, onchain.exponent)} publish_time ${onchain.publishTime} posted_slot ${onchain.postedSlot}`,
  );
  return {
    mode: 'open',
    code,
    signatures,
    priceUpdateAccount: priceUpdate.toBase58(),
    hermes: { price: p.price, conf: p.conf, expo: p.expo, publishTime: p.publish_time },
    onchainUpdate: {
      verificationLevel: onchain.verificationLevel,
      price: onchain.price.toString(),
      conf: onchain.conf.toString(),
      exponent: onchain.exponent,
      publishTime: onchain.publishTime.toString(),
      postedSlot: onchain.postedSlot.toString(),
    },
  };
}

async function closedSession(conn: Connection, payer: Keypair, mint: PublicKey, oracle: PublicKey) {
  console.log(`oracle slot: ${oracle.toBase58()} (passed, never read on a closed market)`);
  const { signature, logs } = await send(
    conn,
    'probe(closed): probe_security',
    [probeSecurityIx(mint, US_EQUITY_CALENDAR_ID, oracle)],
    [payer],
  );
  const code = printVerdict(logs);
  return { mode: 'closed', code, signatures: [{ label: 'probe_security', signature }], oracleSlot: oracle.toBase58() };
}

async function main() {
  const conn = connection();
  const payer = wallet();
  const d = readDeployment();
  if (typeof d.standinMint !== 'string') throw new Error('run create-standin-mint.ts first');
  const mint = new PublicKey(d.standinMint);
  const cal = decodeCalendar((await conn.getAccountInfo(calendarPda(US_EQUITY_CALENDAR_ID)))!.data);

  const clock = await chainClock(conn);
  const session = sessionAt(cal, clock);
  const forced = process.argv.includes('--open') ? 'open' : process.argv.includes('--closed') ? 'closed' : null;
  const mode = forced ?? (session === 'Regular' ? 'open' : 'closed');
  console.log(`rpc ${rpcHost()}  chain clock ${clock} (${new Date(clock * 1000).toISOString()})  session ${session}  mode ${mode}`);

  const before = await readSecurity(conn, mint);
  let result: Record<string, unknown>;
  if (mode === 'open') {
    result = await inSession(conn, payer, mint);
  } else {
    const probes = (d.probes as { priceUpdateAccount?: string }[] | undefined) ?? [];
    const last = [...probes].reverse().find((p) => p.priceUpdateAccount)?.priceUpdateAccount;
    result = await closedSession(conn, payer, mint, new PublicKey(last ?? mint.toBase58()));
  }

  const after = await readSecurity(conn, mint);
  console.log(`\nSecurityState ${securityPda(mint).toBase58()}`);
  console.log(`  refusals ${before.refusals} -> ${after.refusals}`);
  console.log(`  last_refusal_code ${after.lastRefusalCode} (${REFUSAL_NAMES[after.lastRefusalCode] ?? 'none'})  last_refusal_ts ${after.lastRefusalTs}`);
  console.log(
    `  primary: price ${fmtFixed(after.primary.price, after.primary.expo)} conf ${fmtFixed(after.primary.conf, after.primary.expo)} publish_ts ${after.primary.publishTs}  synced_ts ${after.syncedTs}`,
  );

  const record = readDeployment();
  const probes = (record.probes as unknown[] | undefined) ?? [];
  probes.push({
    ...result,
    session,
    chainClock: clock,
    refusalsAfter: after.refusals,
    lastRefusalCode: after.lastRefusalCode,
    lastRefusalTs: after.lastRefusalTs.toString(),
  });
  record.probes = probes;
  writeDeployment(record);
}

main().catch((err) => {
  console.error(err);
  if (err?.logs) console.error(err.logs.join('\n'));
  process.exit(1);
});
