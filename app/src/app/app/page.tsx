import type { Metadata } from 'next';
import Link from 'next/link';

import { Adjustments } from '@/components/instrument/adjustment';
import { Ledger } from '@/components/instrument/ledger';
import { Rail } from '@/components/instrument/rail';
import { SeriesPanel } from '@/components/instrument/series';
import { DEVNET_LIVE } from '@/lib/config';
import { buildAdjustments } from '@/lib/server/adjustment';
import { devnetRecord } from '@/lib/server/devnet';
import { LEDGER_FILE, readLedger } from '@/lib/server/ledger';
import { buildReplay } from '@/lib/server/replay';

import './instrument.css';

export const metadata: Metadata = {
  title: 'The instrument · Deliverable',
  description:
    'The refusal gate for AAPLx and NVDAx, read from Solana mainnet: every check in the program’s order, the oracle basis, the adjustment invariant and the corporate-action ledger.',
};

// Replay, the adjustment and the ledger are computed here, at build time, from the
// repository's pinned records. Live and Preview are read by the browser from /api/rail.
export default async function InstrumentPage() {
  const ledger = readLedger();
  const [replay, adjustments] = await Promise.all([buildReplay(), Promise.resolve(buildAdjustments(ledger))]);
  // The deployment record is read here, at build time, like every other repository
  // record on this page. What the deployed program holds is read live, per request.
  const devnet = DEVNET_LIVE ? devnetRecord() : null;
  const splits = ledger.filter((r) => r.classification === 'split').length;
  const inWindow = ledger.filter((r) => r.inWindow).length;

  return (
    <div className="instrument">
      <a className="skip" href="#gate">
        Skip to the gate
      </a>

      <main>
        <header className="i-head">
          <h1 className="i-title cut">
            THE&nbsp;<span className="dot">&middot;</span> INSTRUMENT
          </h1>
          <p className="i-lede">
            Every condition the program checks before it will write or settle an option, evaluated on real mainnet
            accounts for AAPLx and NVDAx. Nothing here needs a wallet.
          </p>
        </header>

        <Rail replay={replay} devnet={devnet} />

        <section id="adjustment" className="i-section" aria-labelledby="adjustment-title">
          <p className="sect-mark">III &middot; THE ADJUSTMENT</p>
          <h2 id="adjustment-title" className="cut">
            THE&nbsp;<span className="dot">&middot;</span> STRIKE&nbsp;<span className="dot">&middot;</span> RE-CUTS
          </h2>
          <p className="i-intro">
            Two real splits, read off the real mints, run through the SDK&rsquo;s <code>currentStrike</code>: a series
            written one second before the new multiplier took effect, and the same series at the instant it did. The
            strike falls by the ratio, the contract grows by it, and <code>strike &times; ui_size</code> does not move.
            The strikes are chosen for the example; every multiplier is read from the mint.
          </p>
          <Adjustments views={adjustments} />
        </section>

        <section id="ledger" className="i-section" aria-labelledby="ledger-title">
          <p className="sect-mark">IV &middot; CORPORATE ACTIONS</p>
          <h2 id="ledger-title" className="cut">
            THE&nbsp;<span className="dot">&middot;</span> UNIT&nbsp;<span className="dot">&middot;</span> MOVES
          </h2>
          <p className="i-intro">
            Every <code>UpdateMultiplier</code> the keeper recovered from mainnet: {ledger.length} transactions,{' '}
            {splits} of them splits, each linked to its signature. Nothing on chain labels them; the kind column is the
            keeper&rsquo;s reading of the ratio. Marked: the {inWindow} that took effect inside the hackathon window,
            11 to 25 September. Source: <code>{LEDGER_FILE}</code>.
          </p>
          <Ledger rows={ledger} />
        </section>

        <section id="series" className="i-section" aria-labelledby="series-title">
          <p className="sect-mark">V &middot; SERIES AND POSITIONS</p>
          <h2 id="series-title" className="cut">
            WRITE&nbsp;<span className="dot">&middot;</span> AND&nbsp;<span className="dot">&middot;</span> EXERCISE
          </h2>
          <SeriesPanel />
        </section>
      </main>

      <footer className="i-footer">
        <p className="stamp">
          <Link href="/" prefetch={false}>
            DELIVERABLE
          </Link>{' '}
          &middot; READS KAMINO SCOPE, THE XSTOCK MINTS AND JUP.AG PRICE V3 &middot; MIT
          LICENCE
        </p>
      </footer>
    </div>
  );
}
