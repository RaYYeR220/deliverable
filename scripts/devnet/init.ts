// Step 1 of the devnet deployment: the registry and the US equity calendar.
//
//   pnpm tsx init.ts
//
// Idempotent: an account that already exists is reported and skipped. The
// halt attestor is a fresh keypair kept in keys/attestor.json (gitignored).

import {
  ENTRY_CLOSED,
  ENTRY_EARLY_CLOSE,
  REGULAR_CLOSE_MINUTE,
  REGULAR_OPEN_MINUTE,
  US_EQUITY_CALENDAR_ID,
  appendCalendarEntriesIx,
  calendarPda,
  connection,
  decodeCalendar,
  decodeRegistry,
  explorer,
  initCalendarIx,
  initRegistryIx,
  localKeypair,
  recordField,
  registryPda,
  rpcHost,
  send,
  wallet,
  type CalendarEntry,
} from './lib.ts';

/**
 * `US_EQUITY_2026_2027` from programs/deliverable/src/state/registry.rs, which
 * is Pyth's published `Equity.US.*` schedule captured 2026-09-20.
 */
const closed = (month: number, day: number): CalendarEntry => ({
  dateKey: (month << 8) | day,
  kind: ENTRY_CLOSED,
  closeMinute: 0,
});
const early = (month: number, day: number, closeMinute: number): CalendarEntry => ({
  dateKey: (month << 8) | day,
  kind: ENTRY_EARLY_CLOSE,
  closeMinute,
});
export const US_EQUITY_2026_2027: CalendarEntry[] = [
  closed(9, 7), // Labor Day 2026
  closed(11, 26), // Thanksgiving
  early(11, 27, 13 * 60), // day after Thanksgiving
  early(12, 24, 13 * 60), // Christmas Eve
  closed(12, 25), // Christmas
  closed(1, 1), // New Year's Day 2027
  closed(1, 18), // Martin Luther King Jr. Day
  closed(2, 15), // Washington's Birthday
  closed(3, 26), // Good Friday
  closed(5, 31), // Memorial Day
  closed(6, 18), // Juneteenth, observed
  closed(7, 5), // Independence Day, observed
];

async function main() {
  const conn = connection();
  const payer = wallet();
  const attestor = localKeypair('attestor');
  console.log(`rpc      ${rpcHost()}`);
  console.log(`wallet   ${payer.publicKey.toBase58()}`);
  console.log(`attestor ${attestor.publicKey.toBase58()} (keys/attestor.json)`);

  const registry = registryPda();
  const calendar = calendarPda(US_EQUITY_CALENDAR_ID);
  recordField('registry', registry.toBase58());
  recordField('calendar', calendar.toBase58());
  recordField('attestor', attestor.publicKey.toBase58());
  recordField('authority', payer.publicKey.toBase58());

  if (await conn.getAccountInfo(registry)) {
    console.log(`registry ${registry.toBase58()} exists, skipping init_registry`);
  } else {
    await send(conn, 'init_registry', [initRegistryIx(payer.publicKey, attestor.publicKey)], [payer]);
  }

  if (await conn.getAccountInfo(calendar)) {
    console.log(`calendar ${calendar.toBase58()} exists, skipping init_calendar`);
  } else {
    await send(
      conn,
      'init_calendar',
      [initCalendarIx(payer.publicKey, US_EQUITY_CALENDAR_ID, REGULAR_OPEN_MINUTE, REGULAR_CLOSE_MINUTE)],
      [payer],
    );
  }

  const current = decodeCalendar((await conn.getAccountInfo(calendar))!.data);
  const have = new Set(current.entries.map((e) => `${e.dateKey}:${e.kind}:${e.closeMinute}`));
  const missing = US_EQUITY_2026_2027.filter((e) => !have.has(`${e.dateKey}:${e.kind}:${e.closeMinute}`));
  if (missing.length === 0) {
    console.log('calendar already holds all 12 entries, skipping append_calendar_entries');
  } else {
    await send(conn, 'append_calendar_entries', [appendCalendarEntriesIx(payer.publicKey, US_EQUITY_CALENDAR_ID, missing)], [payer]);
  }

  const reg = decodeRegistry((await conn.getAccountInfo(registry))!.data);
  const cal = decodeCalendar((await conn.getAccountInfo(calendar))!.data);
  console.log('\nRegistry', registry.toBase58(), explorer('address', registry.toBase58()));
  console.log(`  authority ${reg.authority.toBase58()}  attestor ${reg.attestor.toBase58()}  paused ${reg.paused}`);
  console.log('Calendar', calendar.toBase58(), explorer('address', calendar.toBase58()));
  console.log(
    `  id ${cal.id}  version ${cal.version}  session ${cal.regularOpenMinute}-${cal.regularCloseMinute} min ET  entries ${cal.entries.length}`,
  );
  for (const e of cal.entries) {
    const mmdd = `${String(e.dateKey >> 8).padStart(2, '0')}-${String(e.dateKey & 0xff).padStart(2, '0')}`;
    console.log(`    ${mmdd} ${e.kind === ENTRY_CLOSED ? 'closed' : `early close ${Math.floor(e.closeMinute / 60)}:${String(e.closeMinute % 60).padStart(2, '0')} ET`}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
