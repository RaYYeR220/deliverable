// Step 1 of the devnet deployment: the registry and the US equity calendar.
//
//   pnpm tsx init.ts                    # the calendar the record names
//   pnpm tsx init.ts --calendar-id=1    # a specific one
//
// Idempotent: an account that already exists is reported and skipped. The
// halt attestor is a fresh keypair kept in keys/attestor.json (gitignored).
//
// `["calendar", id]` is a PDA seed and this program has no instruction to
// close a calendar, so a calendar whose entries were written under an older
// `CalendarEntry` layout is superseded by initialising the next id, not
// rewritten. That is what `--calendar-id` is for.

import {
  ENTRY_CLOSED,
  ENTRY_EARLY_CLOSE,
  REGULAR_CLOSE_MINUTE,
  REGULAR_OPEN_MINUTE,
  appendCalendarEntriesIx,
  calendarId,
  calendarPda,
  connection,
  dateKey,
  decodeCalendar,
  decodeRegistry,
  explorer,
  fmtDateKey,
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
 * `US_EQUITY_2026_2027` from programs/deliverable/src/state/registry.rs, the
 * table the program's own tests resolve sessions against. It is Pyth's
 * published `Equity.US.*` schedule captured 2026-09-20, plus Labor Day 2027,
 * which falls outside the twelve months that capture covers.
 *
 * Each key carries the year. Keying on bare MMDD made every entry fire in
 * every later year, and left the following year's dates missing entirely —
 * which is the direction that reports a regular session on a day the exchange
 * is shut.
 */
const closed = (year: number, month: number, day: number): CalendarEntry => ({
  dateKey: dateKey(year, month, day),
  kind: ENTRY_CLOSED,
  closeMinute: 0,
});
const early = (year: number, month: number, day: number, closeMinute: number): CalendarEntry => ({
  dateKey: dateKey(year, month, day),
  kind: ENTRY_EARLY_CLOSE,
  closeMinute,
});
export const US_EQUITY_2026_2027: CalendarEntry[] = [
  closed(2026, 9, 7), // Labor Day 2026
  closed(2026, 11, 26), // Thanksgiving
  early(2026, 11, 27, 13 * 60), // day after Thanksgiving
  early(2026, 12, 24, 13 * 60), // Christmas Eve
  closed(2026, 12, 25), // Christmas
  closed(2027, 1, 1), // New Year's Day 2027
  closed(2027, 1, 18), // Martin Luther King Jr. Day
  closed(2027, 2, 15), // Washington's Birthday
  closed(2027, 3, 26), // Good Friday
  closed(2027, 5, 31), // Memorial Day
  closed(2027, 6, 18), // Juneteenth, observed
  closed(2027, 7, 5), // Independence Day, observed
  closed(2027, 9, 6), // Labor Day 2027
];

async function main() {
  const conn = connection();
  const payer = wallet();
  const attestor = localKeypair('attestor');
  const id = calendarId();
  console.log(`rpc      ${rpcHost()}`);
  console.log(`wallet   ${payer.publicKey.toBase58()}`);
  console.log(`attestor ${attestor.publicKey.toBase58()} (keys/attestor.json)`);
  console.log(`calendar id ${id}`);

  const registry = registryPda();
  const calendar = calendarPda(id);
  recordField('registry', registry.toBase58());
  recordField('calendarId', id);
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
      `init_calendar(${id})`,
      [initCalendarIx(payer.publicKey, id, REGULAR_OPEN_MINUTE, REGULAR_CLOSE_MINUTE)],
      [payer],
    );
  }

  const current = decodeCalendar((await conn.getAccountInfo(calendar))!.data);
  const have = new Set(current.entries.map((e) => `${e.dateKey}:${e.kind}:${e.closeMinute}`));
  const missing = US_EQUITY_2026_2027.filter((e) => !have.has(`${e.dateKey}:${e.kind}:${e.closeMinute}`));
  if (missing.length === 0) {
    console.log(`calendar already holds all ${US_EQUITY_2026_2027.length} entries, skipping append_calendar_entries`);
  } else {
    await send(conn, `append_calendar_entries(${id})`, [appendCalendarEntriesIx(payer.publicKey, id, missing)], [payer]);
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
    console.log(
      `    ${fmtDateKey(e.dateKey)} ${e.kind === ENTRY_CLOSED ? 'closed' : `early close ${Math.floor(e.closeMinute / 60)}:${String(e.closeMinute % 60).padStart(2, '0')} ET`}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
