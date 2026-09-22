import { solscan } from '@/lib/config';
import type { GateRow, GateView, Sourced } from '@/lib/types';

import { Addr, Segments } from './segments';

const STATUS: Record<GateRow['status'], { reached: string; unreached: string }> = {
  pass: { reached: 'Passes', unreached: 'would pass' },
  refuse: { reached: 'Refuses', unreached: 'would refuse' },
  'not-applicable': { reached: 'Does not apply', unreached: 'does not apply' },
  unobservable: { reached: 'Not observable', unreached: 'not observable' },
};

function Status({ row }: { row: GateRow }) {
  const words = STATUS[row.status];
  if (!row.reached) {
    return (
      <span className="i-status is-unreached">
        <span className="i-status-word">Not reached</span>
        <span className="i-status-would">{words.unreached}</span>
      </span>
    );
  }
  return (
    <span className={`i-status${row.deciding ? ' is-deciding' : ''}`}>
      <span className="i-status-word">{words.reached}</span>
    </span>
  );
}

function refusalLabel(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function GateTablet({ symbol, mint, result }: { symbol: string; mint: string; result: Sourced<GateView> | null }) {
  const headingId = `gate-${symbol}`;
  return (
    <article className="i-tablet" aria-labelledby={headingId}>
      <header className="i-tablet-head">
        <h3 id={headingId} className="i-tablet-symbol">
          {symbol}
        </h3>
        <p className="i-tablet-links">
          <span>mint </span>
          <Addr address={mint} href={solscan('token', mint)} />
          {result?.ok ? (
            <>
              <span> &middot; {result.value.basis === 'preview' ? 'preview basis' : 'registered security '}</span>
              {result.value.basis === 'registered' ? (
                <Addr address={result.value.security} href={solscan('account', result.value.security)} />
              ) : null}
            </>
          ) : null}
        </p>
      </header>

      {result === null ? (
        <p className="i-pending" role="status">
          Reading mainnet through the SDK&hellip;
        </p>
      ) : !result.ok ? (
        <div className="i-down" role="status">
          <p className="i-down-head">Not read</p>
          <p>{result.error}</p>
          <p className="i-down-note">Nothing is shown in its place.</p>
        </div>
      ) : (
        <Evaluation view={result.value} />
      )}
    </article>
  );
}

function Evaluation({ view }: { view: GateView }) {
  const v = view.verdict;
  return (
    <>
      <ol className="i-checks">
        {view.rows.map((row) => (
          <li
            key={row.name}
            className={`i-check${row.deciding ? ' is-deciding' : ''}${row.reached ? '' : ' is-unreached'}`}
          >
            <span className="i-pos" aria-hidden="true">
              {row.position}
            </span>
            <span className="i-what">
              <span className="i-check-name">{row.check}</span>
              <span className="i-check-code">
                {refusalLabel(row.name)} &middot; {row.numeral}
              </span>
            </span>
            <span className="i-reading">
              <span className="i-value">
                <Segments parts={row.value} />
              </span>
              {row.detail.length > 0 ? (
                <span className="i-detail">
                  <Segments parts={row.detail} />
                </span>
              ) : null}
            </span>
            <Status row={row} />
          </li>
        ))}
      </ol>

      <div className="i-verdict">
        {v.actionable ? (
          <>
            <p className="i-verdict-word cut">ACTIONABLE</p>
            <p className="i-verdict-code">NO CHECK REFUSES</p>
            <p className="i-verdict-reason">
              {view.basis === 'preview'
                ? 'Under the preview terms the program would write and exercise against this state now.'
                : 'The program will write and exercise against this state now.'}
              {view.rows.some((r) => r.status === 'unobservable')
                ? ' The halt check is read as not halted, because a preview cannot observe an attestation.'
                : ''}
            </p>
          </>
        ) : (
          <>
            <p className="i-verdict-word cut cut-deep">REFUSED</p>
            <p className="i-verdict-code">
              CODE {v.numeral} &middot; {v.title} &middot; ANCHOR ERROR {v.errorCode}
            </p>
            <p className="i-verdict-reason">{v.reason}</p>
          </>
        )}
        {!view.consistent ? (
          <p className="i-verdict-note">
            The row-by-row reading does not agree with the gate on these inputs. The verdict above is the gate&rsquo;s.
          </p>
        ) : null}
        {view.registryPaused ? (
          <p className="i-verdict-note">
            The registry kill switch is set: write and exercise fail with RegistryPaused whatever this verdict says.
          </p>
        ) : null}
      </div>

      {view.notes.length > 0 ? (
        <details className="i-notes">
          <summary>What this evaluation assumed</summary>
          <ul>
            {view.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}
