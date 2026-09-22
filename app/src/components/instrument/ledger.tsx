'use client';

import { useMemo, useState } from 'react';

import { solscan } from '@/lib/config';
import { multiplier, span, utcMinute } from '@/lib/format';
import type { LedgerRow } from '@/lib/types';

type Filter = 'all' | 'splits' | 'window';

const FIRST_PAGE = 24;

export function Ledger({ rows }: { rows: LedgerRow[] }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState(false);

  const counts = useMemo(
    () => ({
      all: rows.length,
      splits: rows.filter((r) => r.classification === 'split').length,
      window: rows.filter((r) => r.inWindow).length,
    }),
    [rows],
  );
  const filtered = useMemo(
    () => rows.filter((r) => filter === 'all' || (filter === 'splits' ? r.classification === 'split' : r.inWindow)),
    [rows, filter],
  );
  const shown = expanded ? filtered : filtered.slice(0, FIRST_PAGE);

  const options: Array<{ key: Filter; label: string }> = [
    { key: 'all', label: `All ${counts.all}` },
    { key: 'splits', label: `Splits ${counts.splits}` },
    { key: 'window', label: `Hackathon window ${counts.window}` },
  ];

  return (
    <>
      <div className="i-filters" role="group" aria-label="Show">
        {options.map((o) => (
          <button
            key={o.key}
            type="button"
            className="i-filter"
            aria-pressed={filter === o.key}
            onClick={() => {
              setFilter(o.key);
              setExpanded(false);
            }}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="i-table-wrap">
        <table className="i-table i-ledger">
          <caption className="visually-hidden">ScaledUiAmount multiplier changes recovered from mainnet, newest first</caption>
          <thead>
            <tr>
              <th scope="col">Ticker</th>
              <th scope="col">Issued</th>
              <th scope="col">Effective</th>
              <th scope="col" className="num">
                Lead
              </th>
              <th scope="col" className="num">
                Multiplier
              </th>
              <th scope="col">Kind</th>
              <th scope="col">Transaction</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.signature} className={r.inWindow ? 'is-window' : undefined}>
                <th scope="row" data-label="Ticker">
                  <a className="i-link" href={solscan('token', r.mint)} target="_blank" rel="noreferrer">
                    {r.symbol}
                  </a>
                  {r.inWindow ? <span className="i-window-tag">hackathon window</span> : null}
                </th>
                <td data-label="Issued">{utcMinute(r.blockTime)}</td>
                <td data-label="Effective">{utcMinute(r.effectiveTs)}</td>
                <td data-label="Lead" className="num">
                  {span(r.leadSeconds)}
                </td>
                <td data-label="Multiplier" className="num i-mult">
                  {multiplier(r.previous)} &rarr; {multiplier(r.next)}
                </td>
                <td data-label="Kind">{r.classification}</td>
                <td data-label="Transaction">
                  <a className="i-link" href={solscan('tx', r.signature)} target="_blank" rel="noreferrer" title={r.signature}>
                    {r.signature.slice(0, 8)}&hellip;{r.signature.slice(-6)}
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {filtered.length > FIRST_PAGE ? (
        <p className="i-more">
          <button type="button" className="i-reread" onClick={() => setExpanded((e) => !e)} aria-expanded={expanded}>
            {expanded ? `Show the first ${FIRST_PAGE}` : `Show all ${filtered.length}`}
          </button>
        </p>
      ) : null}
    </>
  );
}
