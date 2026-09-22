import { solscan } from '@/lib/config';
import { utc } from '@/lib/format';
import type { AdjustmentView } from '@/lib/types';

import { Addr } from './segments';

export function Adjustments({ views }: { views: AdjustmentView[] }) {
  return (
    <div className="i-adjustments">
      {views.map((v) => (
        <article key={v.symbol} className="i-adjust" aria-labelledby={`adjust-${v.symbol}`}>
          <header className="i-adjust-head">
            <h3 id={`adjust-${v.symbol}`}>
              {v.company} &middot; {v.ratio}
            </h3>
            <p className="i-adjust-meta">
              multiplier {v.from} &rarr; {v.to} &middot; effective {utc(v.effectiveTs)}
              <br />
              mint <Addr address={v.mint} href={solscan('token', v.mint)} />
              {v.signature ? (
                <>
                  {' '}
                  &middot; UpdateMultiplier <Addr address={v.signature} href={solscan('tx', v.signature)} />
                </>
              ) : null}
            </p>
          </header>

          <table className="i-table i-adjust-table">
            <caption className="visually-hidden">{v.symbol} series before and after the multiplier change</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Quantity</span>
                </th>
                <th scope="col" className="num">
                  Before &middot; m {v.before.multiplier}
                </th>
                <th scope="col" className="num">
                  After &middot; m {v.after.multiplier}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Strike per share</th>
                <td className="num" data-label={`Before, m ${v.before.multiplier}`}>
                  {v.before.strike}
                </td>
                <td className="num" data-label={`After, m ${v.after.multiplier}`}>
                  {v.after.strike}
                </td>
              </tr>
              <tr>
                <th scope="row">Shares per contract</th>
                <td className="num" data-label={`Before, m ${v.before.multiplier}`}>
                  {v.before.uiSize}
                </td>
                <td className="num" data-label={`After, m ${v.after.multiplier}`}>
                  {v.after.uiSize}
                </td>
              </tr>
              <tr className="i-invariant">
                <th scope="row">Strike &times; size</th>
                <td className="num" data-label={`Before, m ${v.before.multiplier}`}>
                  {v.before.notional}
                </td>
                <td className="num" data-label={`After, m ${v.after.multiplier}`}>
                  {v.after.notional}
                </td>
              </tr>
              <tr>
                <th scope="row">Cost to exercise one</th>
                <td className="num" data-label={`Before, m ${v.before.multiplier}`}>
                  {v.before.exerciseCost}
                </td>
                <td className="num" data-label={`After, m ${v.after.multiplier}`}>
                  {v.after.exerciseCost}
                </td>
              </tr>
            </tbody>
          </table>

          <p className="i-adjust-verdict">
            {v.invariantHeld
              ? 'Strike × size is the same integer on both sides of the change.'
              : 'Strike × size moved across the change.'}
          </p>
          <p className="i-adjust-control">
            Written unadjusted, the same series keeps its strike at {v.control.strike} while the contract grows to{' '}
            {v.control.uiSize}: a notional of {v.control.notional}, {v.control.factor} times what the writer
            collateralised.
          </p>
          <p className="i-terms">
            series terms &middot; strike0 {v.terms.strike0} &middot; multiplier_at_mint {v.terms.multiplierAtMint} &middot;
            contract_raw_size {v.terms.contractRawSize} &middot; underlying_decimals {v.terms.underlyingDecimals} &middot;
            mint bytes {v.fixture}
          </p>
        </article>
      ))}
    </div>
  );
}
