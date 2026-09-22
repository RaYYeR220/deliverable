import { SCOPE_PRICES, solscan } from '@/lib/config';
import { bps, et, price, signed, span, utc } from '@/lib/format';
import type { BasisRow, BasisView, Sourced } from '@/lib/types';

import { Addr } from './segments';

interface Delta {
  moved: number;
  tsAdvanced: number;
  slotAdvanced: number | null;
  gap: number;
}

function deltaFor(row: BasisRow, view: BasisView, anchor: BasisView | null): Delta | null {
  if (view.source === 'pinned') {
    if (row.moved === undefined || row.tsAdvanced === undefined || view.gapSeconds === null) return null;
    return { moved: row.moved, tsAdvanced: row.tsAdvanced, slotAdvanced: row.slotAdvanced ?? null, gap: view.gapSeconds };
  }
  if (!anchor || anchor.at >= view.at) return null;
  const first = anchor.rows.find((r) => r.symbol === row.symbol);
  if (!first) return null;
  return {
    moved: row.oraclePrice - first.oraclePrice,
    tsAdvanced: row.oracleTs - first.oracleTs,
    slotAdvanced: row.oracleSlot !== null && first.oracleSlot !== null ? row.oracleSlot - first.oracleSlot : null,
    gap: view.at - anchor.at,
  };
}

export function Basis({ result, anchor }: { result: Sourced<BasisView> | null; anchor: BasisView | null }) {
  if (result === null) {
    return (
      <p className="i-pending" role="status">
        Reading Scope and jup.ag&hellip;
      </p>
    );
  }
  if (!result.ok) {
    return (
      <div className="i-down" role="status">
        <p className="i-down-head">Not read</p>
        <p>{result.error}</p>
        <p className="i-down-note">No oracle or market price is shown in its place.</p>
      </div>
    );
  }

  const view = result.value;
  const lead = view.rows[0];
  const economic = view.lastClose !== null ? view.at - view.lastClose : null;
  const firstDelta = lead ? deltaFor(lead, view, anchor) : null;

  return (
    <>
      {lead ? (
        <div className="i-ages">
          <p className="i-age">
            <span className="i-age-fig cut">{span(lead.reportedAge)}</span>
            <span className="i-age-cap">
              the age the {lead.symbol} feed reports for itself, from its own timestamp
            </span>
          </p>
          <p className="i-age">
            <span className="i-age-fig cut cut-deep">{economic !== null ? span(economic) : 'In session'}</span>
            <span className="i-age-cap">
              {economic !== null && view.lastClose !== null
                ? `since the reference market last traded a regular session: it closed ${et(view.lastClose)}, per the committed calendar`
                : 'the reference market is in its regular session, so the price can be as fresh as its timestamp says'}
            </span>
          </p>
        </div>
      ) : null}

      <p className="i-basis-stamp">
        {view.source === 'live' ? 'READ ' : 'RECORDED '}
        {utc(view.at)}
        {view.slot !== null ? ` · SLOT ${view.slot.toLocaleString('en-US')}` : ''}
        {' · ORACLE '}
        <Addr address={SCOPE_PRICES} href={solscan('account', SCOPE_PRICES)} />
        {' · MARKET '}
        {view.market.source.toUpperCase()}
      </p>

      {!view.market.ok ? (
        <p className="i-down-inline" role="status">
          The on-chain market price could not be read ({view.market.error}). The market and basis columns are empty
          rather than filled with an older number.
        </p>
      ) : null}

      <div className="i-table-wrap">
        <table className="i-table i-basis-table">
          <caption className="visually-hidden">Oracle price per share against the on-chain market price per share</caption>
          <thead>
            <tr>
              <th scope="col">Security</th>
              <th scope="col">Scope entry</th>
              <th scope="col" className="num">
                Oracle, per token
              </th>
              <th scope="col" className="num">
                Multiplier
              </th>
              <th scope="col" className="num">
                Oracle, per share
              </th>
              <th scope="col" className="num">
                On chain, per share
              </th>
              <th scope="col" className="num">
                Basis
              </th>
              <th scope="col" className="num">
                Bare
              </th>
              <th scope="col" className="num">
                Reported age
              </th>
              <th scope="col" className="num">
                {view.source === 'pinned' ? `Moved in ${view.gapSeconds ?? ''} s` : 'Moved since first read'}
              </th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row) => {
              const delta = deltaFor(row, view, anchor);
              return (
                <tr key={row.symbol}>
                  <th scope="row" data-label="Security">
                    <a className="i-link" href={solscan('token', row.mint)} target="_blank" rel="noreferrer">
                      {row.symbol}
                    </a>
                  </th>
                  <td data-label="Scope entry" className="i-entry">
                    <span>
                      #{row.scopeIndex}
                      {row.scopeLabel ? <span className="i-entry-label"> {row.scopeLabel}</span> : null}
                    </span>
                  </td>
                  <td data-label="Oracle, per token" className="num">
                    {price(row.oraclePrice)}
                  </td>
                  <td data-label="Multiplier" className="num">
                    {row.multiplier !== null ? String(row.multiplier) : <span className="i-absent">not read</span>}
                  </td>
                  <td data-label="Oracle, per share" className="num">
                    {row.oraclePerShare !== null ? price(row.oraclePerShare) : <span className="i-absent">none</span>}
                  </td>
                  <td data-label="On chain, per share" className="num">
                    {row.marketPrice !== null ? price(row.marketPrice) : <span className="i-absent">not read</span>}
                  </td>
                  <td data-label="Basis" className="num i-strong">
                    {row.basisBps !== null ? bps(row.basisBps) : <span className="i-absent">none</span>}
                  </td>
                  <td data-label="Bare, mixed units" className="num">
                    {row.basisBareBps !== null ? bps(row.basisBareBps) : <span className="i-absent">none</span>}
                  </td>
                  <td data-label="Reported age" className="num">
                    {span(row.reportedAge)}
                  </td>
                  <td data-label={view.source === 'pinned' ? 'Moved' : 'Moved since first read'} className="num">
                    {delta ? (
                      <span>
                        <span className={delta.moved === 0 ? 'i-held' : undefined}>{signed(delta.moved)}</span>
                        <span className="i-delta-sub">
                          ts +{delta.tsAdvanced} s{delta.slotAdvanced !== null ? ` · slot +${delta.slotAdvanced}` : ''}
                        </span>
                      </span>
                    ) : (
                      <span className="i-absent">awaiting a second read</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <p className="i-foot">
        {view.source === 'pinned' ? (
          <>
            Recorded by <code>scripts/measure-basis.py</code>: two samples {view.gapSeconds} seconds apart; the table is
            the second. Record: <a href={`/evidence/${view.record?.split('/').pop() ?? ''}`}>{view.record}</a>. The
            record&rsquo;s own <code>basis_bps</code> field was computed bare; the basis here is recomputed like for like
            from its raw prices.
          </>
        ) : firstDelta ? (
          <>Compared with this page&rsquo;s first read, {span(firstDelta.gap)} ago.</>
        ) : (
          <>The page reads again every thirty seconds; the last column fills once there are two reads to compare.</>
        )}{' '}
        Scope prices one unscaled token; jup.ag prices one share, and a token is <em>multiplier</em> shares. Basis is (on
        chain &minus; oracle per share) &divide; oracle per share, where oracle per share is oracle &divide; multiplier.
        Bare sets the two prices against each other unconverted, which is off by the multiplier: it is shown so the
        correction stays visible. Multipliers: {view.multiplierSource}.
      </p>
    </>
  );
}
