import Link from 'next/link';

import { REPOSITORY_URL } from '@/lib/config';

import './landing.css';

export default function Landing() {
  return (
    <div className="landing">
      <a className="skip" href="#problem">
        Skip to the argument
      </a>

      <p className="architrave">DELIVERABLE &middot; OPTIONS ON TOKENIZED US EQUITY &middot; SOLANA MAINNET</p>

      <main>
        <section id="hero">
          <div className="slab">
            <h1 className="inscription cut">
              <span className="line">
                IT&nbsp;<span className="dot">&middot;</span> <span className="deep">REFUSES</span>&nbsp;
                <span className="dot">&middot;</span> WHEN&nbsp;<span className="dot">&middot;</span> IT
              </span>
              <span className="line">
                CANNOT&nbsp;<span className="dot">&middot;</span> DEFEND&nbsp;<span className="dot">&middot;</span> THE&nbsp;
                <span className="dot">&middot;</span> STATE
              </span>
            </h1>

            <div className="rule" aria-hidden="true" />

            <p className="sub">
              Covered calls on real tokenized shares, settled in the share itself. A Solana program cannot read the
              closing bell; we built the field that can, and the venue will not act without it.
            </p>

            <Link className="cta" href="/app" prefetch={false}>
              Open the instrument
            </Link>
          </div>
        </section>

        <section id="problem">
          <div className="col">
            <p className="sect-mark">I &middot; THE PROBLEM</p>
            <h2 className="cut">
              FOUR&nbsp;<span className="dot">&middot;</span> STATES&nbsp;<span className="dot">&middot;</span> ONE&nbsp;
              <span className="dot">&middot;</span> SILENCE
            </h2>

            <p className="lede">
              A Solana program cannot find out what is true about a tokenized stock. It can read a price account. It
              cannot read a market.
            </p>

            <p className="body">
              When the last print stops moving, four entirely different conditions arrive at the program as the same
              bytes: the same price, the same publisher, a timestamp that keeps counting. Nothing on chain
              distinguishes them, and each one demands a different answer from a venue that is about to take
              someone&rsquo;s collateral.
            </p>

            <ul className="roll">
              <li>
                <span className="state">THE MARKET IS CLOSED</span>
                <span className="gloss">Scheduled, public, knowable a year in advance. Not an incident.</span>
              </li>
              <li>
                <span className="state">THE STOCK IS HALTED</span>
                <span className="gloss">
                  The session is open; this one security is not trading. Usually because something is about to be
                  announced.
                </span>
              </li>
              <li>
                <span className="state">THE ORACLE HAS STOPPED</span>
                <span className="gloss">
                  The market is open and printing. The feed is not. This is the only one of the four that is a fault.
                </span>
              </li>
              <li>
                <span className="state">THE SESSION CLOSED EARLY</span>
                <span className="gloss">
                  Half-day, holiday eve, or a rulebook suspension. The calendar said one thing; the exchange did
                  another.
                </span>
              </li>
            </ul>

            <div className="rule" aria-hidden="true" />

            <p className="body">
              The standard defence against all four is one call: <code>get_price_no_older_than</code>. It asks whether
              the price is fresh, and it refuses if not. On a perpetual asset that is a correct and sufficient guard.
              On an equity it is structurally wrong, because it treats staleness as an exception when staleness is the
              normal state.
            </p>

            <p className="ratio">
              <span className="fig cut">32.5 &frasl; 168</span>
              <span className="cap">
                Hours the New York Stock Exchange is open in a week, against the hours in a week. For roughly eighty
                per cent of the week, an honest equity feed is supposed to be still &mdash; and a freshness check
                cannot tell that stillness from a failure.
              </span>
            </p>

            <p className="body" style={{ marginTop: 'var(--s5)' }}>
              So a venue built on freshness alone is closed when it should be open, open when it should be closed, and
              unable to say which of the two it is doing.
            </p>
          </div>
        </section>

        <section id="measurement">
          <div className="col col-wide">
            <p className="sect-mark">II &middot; THE MEASUREMENT</p>
            <h2 className="cut">
              WE&nbsp;<span className="dot">&middot;</span> WENT&nbsp;<span className="dot">&middot;</span> AND&nbsp;
              <span className="dot">&middot;</span> LOOKED
            </h2>

            <p className="lede">
              Two readings taken off Solana mainnet, against the on-chain market price of the same tokenized shares.
              No simulation, no backtest.
            </p>

            <div className="record">
              <p className="record-head">RECORD I &middot; SUNDAY 2026-09-20 09:15 UTC</p>
              <p className="record-sub">Thirty-seven hours after the New York close. Two samples, ninety seconds apart.</p>

              <dl className="ledger">
                <dt>Oracle timestamp</dt>
                <dd>+82 s</dd>
                <dt>Slot</dt>
                <dd>+312</dd>
                <dt>Price, moved</dt>
                <dd className="held">0.0000</dd>
              </dl>

              <p className="body">
                The publisher was alive. The clock advanced, the chain advanced, the number did not. Meanwhile the
                shares themselves were changing hands on chain at a different price, and the gap was not noise:
              </p>

              <dl className="ledger">
                <dt>CRCLx</dt>
                <dd>&minus;269 bps</dd>
                <dt>HOODx</dt>
                <dd>&minus;236 bps</dd>
                <dt>AAPLx</dt>
                <dd>&minus;101 bps</dd>
              </dl>

              <p className="note">AAPLx &middot; ORACLE 336.7021 &middot; MARKET 333.2898 &middot; BASIS &minus;101 BPS</p>
            </div>

            <div className="record">
              <p className="record-head">RECORD II &middot; TUESDAY 2026-09-22 08:11 UTC</p>
              <p className="record-sub">Not a weekend. An ordinary overnight window, between one session and the next.</p>

              <dl className="ledger">
                <dt>CRCLx</dt>
                <dd>&minus;324 bps</dd>
                <dt>COINx</dt>
                <dd>&minus;268 bps</dd>
                <dt>HOODx</dt>
                <dd>&minus;236 bps</dd>
                <dt>AAPLx</dt>
                <dd>&minus;55 bps</dd>
              </dl>

              <p className="verdict cut">IT RECURS EVERY NIGHT, NOT ONCE A WEEK</p>
            </div>

            <div className="rule" aria-hidden="true" />

            <p className="body">
              The oracle is not broken, and it is not permanently frozen. Between those two readings it moved a great
              deal, because the market opened and it tracked what the market did:
            </p>

            <ul className="events">
              <li>
                <span className="ev">NVDAx</span>
                <span className="val">222.35 &rarr; 227.71</span>
              </li>
              <li>
                <span className="ev">METAx</span>
                <span className="val">669.79 &rarr; 747.24</span>
              </li>
            </ul>

            <p className="body" style={{ marginTop: 'var(--s4)' }}>
              That is the finding, stated precisely. The feed does exactly what it was built to do. It freezes while
              the reference market is shut &mdash; which is correct behaviour for a price, and a trap for anything that
              settles against one.
            </p>

            <p className="marked">
              <span className="fig cut">$22.8M</span>
              <span className="cap">
                of collateral in Kamino&rsquo;s xStocks market, whose AAPLx and NVDAx reserves price from
                this feed.
              </span>
            </p>
          </div>
        </section>

        <section id="mechanisms">
          <div className="col col-wide">
            <p className="sect-mark">III &middot; THE MECHANISMS</p>
            <h2 className="cut">
              TWO&nbsp;<span className="dot">&middot;</span> THINGS&nbsp;<span className="dot">&middot;</span> HAD&nbsp;
              <span className="dot">&middot;</span> TO&nbsp;<span className="dot">&middot;</span> BE&nbsp;
              <span className="dot">&middot;</span> BUILT
            </h2>

            <div className="mech">
              <span className="numeral">MECHANISM I</span>
              <h3>SPLITTING THE FOUR STATES</h3>

              <p className="body">
                Market hours are public, fixed and knowable in advance. Deciding that the market is shut therefore
                needs no oracle &mdash; it needs arithmetic. The session is computed on chain from a committed exchange
                calendar: Unix timestamp, to US Eastern civil time, to session, with holidays and half-days carried as
                explicit exceptions on the calendar account.
              </p>

              <p className="body">
                That makes the most frequent gate in the system the one gate that trusts nobody. It is also the only
                check that still works when every price feed on chain is lying. What remains &mdash; halt, outage,
                early close &mdash; is answered separately, by attestation, by staleness inside an open session, and by
                the calendar&rsquo;s own exception list.
              </p>

              <p className="formula">session(calendar, now) == CLOSED</p>
              <p className="formula-cap">refused before a price account is ever opened</p>
            </div>

            <div className="mech">
              <span className="numeral">MECHANISM II</span>
              <h3>THE ADJUSTMENT INVARIANT</h3>

              <p className="body">
                There is no on-chain corporate-action feed for tokenized equities. The only signal is the Token-2022{' '}
                <code>ScaledUiAmount</code> multiplier on the mint: unlabelled, set by a single keypair, emitting no
                event. A dividend and a split are the same write with different magnitudes &mdash; which is precisely
                why we never have to classify them.
              </p>

              <p className="formula">strike &times; ui_size = constant</p>

              <p className="body">
                The contract holds its notional across any multiplier change. One formula covers a six-basis-point
                dividend accrual and a ten-for-one split identically; nothing has to recognise which kind of event it
                is looking at. The raw quantity delivered on exercise is stored raw, not in UI units, so a split cannot
                change what the holder receives.
              </p>

              <ul className="events">
                <li>
                  <span className="ev">NETFLIX &middot; 10-FOR-1</span>
                  <span className="val">multiplier 1.0 &rarr; 10.0</span>
                </li>
                <li>
                  <span className="ev">CROWDSTRIKE &middot; 4-FOR-1</span>
                  <span className="val">multiplier 1.0 &rarr; 4.0</span>
                </li>
              </ul>

              <p className="body" style={{ marginTop: 'var(--s4)' }}>
                A series can also be written unadjusted, ignoring the mint entirely. Every options venue on tokenized
                equities today writes one of those by omission. Being able to express it is what makes the invariant
                falsifiable rather than merely asserted.
              </p>
            </div>
          </div>
        </section>

        <section id="refusal">
          <div className="col col-wide">
            <p className="sect-mark">IV &middot; THE STATE MACHINE</p>
            <h2 className="cut">
              REFUSAL&nbsp;<span className="dot">&middot;</span> IS&nbsp;<span className="dot">&middot;</span> NOT&nbsp;
              <span className="dot">&middot;</span> AN&nbsp;<span className="dot">&middot;</span> ERROR
            </h2>

            <p className="lede">
              A venue that will not write into an undefendable state is not failing. It is doing the one thing a
              clearing house exists to do.
            </p>

            <p className="refused-word cut cut-deep">REFUSED</p>

            <p className="body" style={{ textAlign: 'center' }}>
              No colour is added to the word. It is cut deeper and tracked wider than anything else on this page, and
              that is the whole of the notation &mdash; the same way a rulebook prints a suspension in the same ink as
              everything else.
            </p>

            <div className="rule rule-tight" aria-hidden="true" />

            <p className="body">
              Nine reasons, numbered and stable. The integers do not change, because the SDK and the app display them
              and a refused transaction is a published artifact. Each refusal emits its code in the transaction log, so
              the reason survives the revert.
            </p>

            <ol className="codes">
              <li>
                <span className="num">I</span>
                <span className="name">MARKET CLOSED</span>
                <span className="why">
                  The exchange calendar says the market is shut. Computed on chain; no oracle is consulted.
                </span>
              </li>
              <li>
                <span className="num">II</span>
                <span className="name">HALTED</span>
                <span className="why">A halt has been attested for this security.</span>
              </li>
              <li>
                <span className="num">III</span>
                <span className="name">ORACLE STALE</span>
                <span className="why">
                  The price is older than this security&rsquo;s tolerance, inside an open session.
                </span>
              </li>
              <li>
                <span className="num">IV</span>
                <span className="name">CONFIDENCE BLOWN</span>
                <span className="why">Reported confidence is too wide a fraction of the price.</span>
              </li>
              <li>
                <span className="num">V</span>
                <span className="name">MULTIPLIER PENDING</span>
                <span className="why">
                  A multiplier change is scheduled and has not taken effect. A contract cannot be settled into a
                  corporate action that is already announced.
                </span>
              </li>
              <li>
                <span className="num">VI</span>
                <span className="name">ISSUER PAUSED</span>
                <span className="why">The issuer has set the mint&rsquo;s Pausable extension.</span>
              </li>
              <li>
                <span className="num">VII</span>
                <span className="name">HOOK ATTACHED</span>
                <span className="why">
                  A transfer hook has been attached to the mint since we last looked. We refuse to transfer into
                  unknown code rather than find out in production what it does.
                </span>
              </li>
              <li>
                <span className="num">VIII</span>
                <span className="name">SOURCES DISAGREE</span>
                <span className="why">Two independent price sources disagree by more than the allowed divergence.</span>
              </li>
              <li>
                <span className="num">IX</span>
                <span className="name">SINGLE SOURCE</span>
                <span className="why">The security is bound to one price source, and nothing corroborates it.</span>
              </li>
            </ol>

            <p className="verdict cut" style={{ marginTop: 'var(--s5)' }}>
              THE VENUE STATES ITS REASON
              <br />
              AND DECLINES
            </p>
          </div>
        </section>
      </main>

      <footer id="spec">
        <div className="col col-wide">
          <ul className="colophon">
            {REPOSITORY_URL ? (
              <>
                <li>
                  <a href={REPOSITORY_URL}>Repository</a>
                </li>
                <li>
                  <a href={`${REPOSITORY_URL}#readme`}>Specification</a>
                </li>
              </>
            ) : null}
            <li>
              <a href="/evidence/weekend-2026-09-20.json">Proof of measurement</a>
            </li>
          </ul>
          <p className="stamp">DELIVERABLE &middot; SOLANA MAINNET &middot; MIT LICENCE</p>
          <p className="stamp">
            2026-09-20 09:15 UTC &middot; 37 H AFTER THE CLOSE &middot; &Delta;T +82 S &middot; &Delta;SLOT +312
            &middot; &Delta;PX 0.0000
          </p>
        </div>
      </footer>
    </div>
  );
}
