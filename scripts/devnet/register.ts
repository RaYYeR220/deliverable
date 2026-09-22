// Step 3: register the stand-in mint as a security, bound to Pyth AAPL as a
// single declared source.
//
//   pnpm tsx register.ts
//   pnpm tsx register.ts --calendar-id=1 --mint=<pubkey>
//
// Devnet has no second, independently sourced AAPL price (no Kamino Scope
// account), so the binding is `OracleBinding::SingleDeclared`. That is spelled
// out rather than papered over, and the gate refuses on it with SingleSource
// (code 9) inside the session, after every other check has run against the
// real Pyth update.

import { PublicKey } from '@solana/web3.js';

import {
  AAPL_FEED,
  DEFAULT_MAX_CONF_BPS,
  DEFAULT_MAX_DIVERGENCE_BPS,
  DEFAULT_MAX_PRICE_AGE_SECS,
  PYTH_OUTER_MAX_AGE_SECS,
  calendarId,
  calendarPda,
  connection,
  explorer,
  option,
  readDeployment,
  recordField,
  registerSecurityIx,
  rpcHost,
  securityPda,
  send,
  wallet,
} from './lib.ts';

async function main() {
  const conn = connection();
  const payer = wallet();
  const d = readDeployment();
  const recorded = option('mint') ?? d.standinMint;
  if (typeof recorded !== 'string') throw new Error('run create-standin-mint.ts first, or pass --mint=<pubkey>');
  const mint = new PublicKey(recorded);
  const id = calendarId();
  const security = securityPda(mint);
  console.log(`rpc      ${rpcHost()}`);
  console.log(`mint     ${mint.toBase58()} (AAPLx devnet stand-in)`);
  console.log(`calendar ${id} ${calendarPda(id).toBase58()}`);
  console.log(`security ${security.toBase58()}`);
  if (!(await conn.getAccountInfo(calendarPda(id)))) {
    throw new Error(`calendar ${id} does not exist; run init.ts --calendar-id=${id} first`);
  }

  recordField('security', security.toBase58());
  recordField('binding', {
    kind: 'SingleDeclared',
    primary: { kind: 'Pyth', feed: 'Equity.US.AAPL/USD', feedId: AAPL_FEED, maxAge: PYTH_OUTER_MAX_AGE_SECS },
    maxPriceAge: DEFAULT_MAX_PRICE_AGE_SECS,
    maxConfBps: DEFAULT_MAX_CONF_BPS,
    maxDivergenceBps: DEFAULT_MAX_DIVERGENCE_BPS,
  });

  if (await conn.getAccountInfo(security)) {
    console.log('security already registered, nothing to do');
    return;
  }

  await send(
    conn,
    `register_security (calendar ${id})`,
    [
      registerSecurityIx({
        authority: payer.publicKey,
        mint,
        calendarId: id,
        symbol: 'AAPLd',
        sources: {
          kind: 'SingleDeclared',
          primary: { kind: 'Pyth', feedId: Buffer.from(AAPL_FEED.slice(2), 'hex'), maxAge: PYTH_OUTER_MAX_AGE_SECS },
        },
        maxPriceAge: DEFAULT_MAX_PRICE_AGE_SECS,
        maxConfBps: DEFAULT_MAX_CONF_BPS,
        maxDivergenceBps: DEFAULT_MAX_DIVERGENCE_BPS,
      }),
    ],
    [payer],
  );
  console.log(`\nSecurityState ${security.toBase58()}`);
  console.log(`  ${explorer('address', security.toBase58())}`);
}

main().catch((err) => {
  console.error(err);
  if (err?.logs) console.error(err.logs.join('\n'));
  process.exit(1);
});
