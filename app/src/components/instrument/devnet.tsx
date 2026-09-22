import { explorer } from '@/lib/config';
import { span, utc } from '@/lib/format';
import type { DevnetRecord, DevnetState, Sourced } from '@/lib/types';

import { Addr } from './segments';

const DEVNET = 'devnet' as const;

function Note({ children }: { children: React.ReactNode }) {
  return <span className="i-entry-label i-state-note">{children}</span>;
}

/**
 * Live, against the program deployed on devnet. The upper table is read from the
 * program's own SecurityState; the lower one is the deployment record in the
 * repository, and says so. Nothing here is recomputed off-chain.
 */
export function DevnetTablet({ record, state }: { record: DevnetRecord; state: Sourced<DevnetState> | null }) {
  const mint = state?.ok ? state.value.mint : record.standinMint;
  const security = state?.ok ? state.value.security : record.security;

  return (
    <article className="i-tablet i-devnet" aria-labelledby="devnet-title">
      <header className="i-tablet-head">
        <h3 id="devnet-title" className="i-tablet-symbol">
          LIVE &middot; DEVNET
        </h3>
        <p className="i-tablet-links">
          <span>program </span>
          <Addr address={record.programId} href={explorer('address', record.programId, DEVNET)} />
          <span> &middot; security </span>
          <Addr address={security} href={explorer('address', security, DEVNET)} />
          <span> &middot; mint </span>
          <Addr address={mint} href={explorer('address', mint, DEVNET)} />
        </p>
      </header>

      <p className="i-devnet-note">
        <strong>The security here is a devnet stand-in.</strong> AAPLd is a Token-2022 mint created for this
        deployment, carrying AAPLx&rsquo;s extension set, with no supply. Devnet has no xStocks, so there is no real one
        to register, and no Kamino Scope account, so no second, independently sourced AAPL price exists. The security is
        therefore bound to Pyth alone, and the program refuses by design.
        {state?.ok && state.value.mintName ? (
          <>
            {' '}
            The mint&rsquo;s own metadata, read back from devnet, says{' '}
            <span className="i-mono">
              {state.value.mintSymbol ?? '?'} &middot; {state.value.mintName}
            </span>
            .
          </>
        ) : null}
      </p>

      {state === null ? (
        <p className="i-pending" role="status">
          Reading the program on devnet&hellip;
        </p>
      ) : !state.ok ? (
        <div className="i-down" role="status">
          <p className="i-down-head">Not read</p>
          <p>{state.error}</p>
          <p className="i-down-note">Nothing is shown in its place.</p>
        </div>
      ) : (
        <Reading view={state.value} />
      )}

      <Probes record={record} />

      <p className="i-foot">
        Live refuses on devnet because devnet has no second, independently sourced price for AAPL: one uncorroborated
        number is not treated as a price. The path where every check passes is proven elsewhere &mdash; by the 142
        LiteSVM tests, which run the compiled program against real mainnet account dumps, and by Preview, which runs the
        same gate on live mainnet accounts for AAPLx and NVDAx.
      </p>
    </article>
  );
}

function Reading({ view }: { view: DevnetState }) {
  const price = view.price;
  return (
    <>
      <div className="i-table-wrap">
        <table className="i-table i-state">
          <caption className="visually-hidden">
            The SecurityState the deployed program holds for {view.symbol} on devnet
          </caption>
          <thead>
            <tr>
              <th scope="col">Reading</th>
              <th scope="col">What the program holds, read from its SecurityState</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Binding</th>
              <td>
                {view.binding.kind}
                {' · '}
                {view.binding.feedName ? `Pyth ${view.binding.feedName}` : view.binding.source}
                <Note>
                  {view.binding.feedId ? (
                    <>
                      feed id <span className="i-mono">0x{view.binding.feedId}</span> as read from the security
                      {view.binding.feedName ? ', the id registered under that name' : ''}
                      {view.binding.maxAge !== null ? `; outer bound ${view.binding.maxAge} s` : ''}.{' '}
                    </>
                  ) : null}
                  {view.binding.secondary
                    ? `Checked against ${view.binding.secondary}.`
                    : 'Declared single source: nothing corroborates it.'}
                </Note>
              </td>
            </tr>

            <tr>
              <th scope="row">Pyth price recorded</th>
              <td>
                {price ? (
                  <>
                    ${price.text} &plusmn; ${price.conf}
                    <Note>
                      the confidence band is {price.confBps} bps of price, against this security&rsquo;s bound of{' '}
                      {view.tolerances.maxConfBps} bps. Written by <code>sync_security</code> from a Pyth update posted
                      through the devnet receiver.
                    </Note>
                  </>
                ) : (
                  <span className="i-absent">no price has been recorded on this security</span>
                )}
              </td>
            </tr>

            <tr>
              <th scope="row">Published</th>
              <td>
                {price ? (
                  <>
                    {utc(price.publishTs)}
                    <Note>
                      {span(price.age)} before this read.
                      {view.lastRefusalTs >= price.publishTs
                        ? ` When the program last ruled it was ${span(view.lastRefusalTs - price.publishTs)} old, inside the ${view.tolerances.maxAge} s staleness bound.`
                        : ''}
                    </Note>
                  </>
                ) : (
                  <span className="i-absent">not recorded</span>
                )}
              </td>
            </tr>

            <tr>
              <th scope="row">Synced</th>
              <td>
                {view.syncedTs > 0 ? (
                  <>
                    {utc(view.syncedTs)}
                    <Note>when the program last copied the oracle onto this security</Note>
                  </>
                ) : (
                  <span className="i-absent">never synced</span>
                )}
              </td>
            </tr>

            <tr>
              <th scope="row">Multiplier recorded</th>
              <td>
                {view.observedMultiplier}
                <Note>
                  the stand-in&rsquo;s <code>ScaledUiAmount</code> multiplier as the program stored it, in 1e12 fixed
                  point.
                  {view.pendingMultiplier ? ` A change to ${view.pendingMultiplier} is pending.` : ' Nothing is pending.'}
                </Note>
              </td>
            </tr>

            <tr>
              <th scope="row">Refusals</th>
              <td>
                {view.refusals}
                <Note>
                  counted by <code>probe_security</code>, which is the only path that can record one: an instruction
                  that refuses reverts, and takes its own counter with it.
                </Note>
              </td>
            </tr>

            <tr>
              <th scope="row">Last refusal code</th>
              <td>
                {view.lastRefusalCode}
                {view.lastRefusalName ? ` · ${view.lastRefusalName}` : ''}
                <Note>{view.lastRefusalReason ?? 'no refusal code has been recorded'}</Note>
              </td>
            </tr>

            <tr>
              <th scope="row">Last refusal at</th>
              <td>
                {view.lastRefusalTs > 0 ? (
                  <>
                    {utc(view.lastRefusalTs)}
                    <Note>{span(view.chainClock - view.lastRefusalTs)} before this read</Note>
                  </>
                ) : (
                  <span className="i-absent">no refusal recorded</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="i-verdict">
        {view.lastRefusalName ? (
          <>
            <p className="i-verdict-word cut cut-deep">REFUSED</p>
            <p className="i-verdict-code">
              CODE {view.lastRefusalNumeral} &middot; {view.lastRefusalTitle} &middot; ANCHOR ERROR{' '}
              {view.lastRefusalErrorCode}
            </p>
            <p className="i-verdict-reason">{view.lastRefusalReason}</p>
            <p className="i-verdict-note">
              This is not a recomputation. The program ran its own gate on chain and wrote this code onto the
              SecurityState at {utc(view.lastRefusalTs)}; what is above is that record, read back from devnet.
            </p>
          </>
        ) : (
          <p className="i-verdict-reason">
            The program has recorded no refusal on this security. Nothing is shown in place of a verdict it did not
            write.
          </p>
        )}
        {view.halted ? <p className="i-verdict-note">A halt is attested on this security.</p> : null}
        {view.registryPaused ? (
          <p className="i-verdict-note">
            The registry kill switch is set: write and exercise fail with RegistryPaused whatever this verdict says.
          </p>
        ) : null}
      </div>
    </>
  );
}

function Probes({ record }: { record: DevnetRecord }) {
  return (
    <div className="i-devnet-probes">
      <p className="i-probes-head">The probes that produced those codes</p>
      <div className="i-table-wrap">
        <table className="i-table i-probes">
          <caption className="visually-hidden">Gate probes sent to the devnet deployment</caption>
          <thead>
            <tr>
              <th scope="col">Probe</th>
              <th scope="col">Chain time</th>
              <th scope="col">Session</th>
              <th scope="col">Code produced</th>
              <th scope="col">Transactions</th>
            </tr>
          </thead>
          <tbody>
            {record.probes.length > 0 ? (
              record.probes.map((probe, i) => (
                <tr key={`${probe.mode}-${i}`}>
                  <th scope="row" data-label="Probe">
                    {i + 1} &middot; {probe.mode}
                  </th>
                  <td data-label="Chain time">
                    {probe.chainClock !== null ? utc(probe.chainClock) : <span className="i-absent">not recorded</span>}
                  </td>
                  <td data-label="Session">{probe.session ?? <span className="i-absent">not recorded</span>}</td>
                  <td data-label="Code produced">
                    {probe.code !== null ? (
                      <>
                        {probe.code}
                        {probe.codeName ? ` · ${probe.codeName}` : ''}
                      </>
                    ) : (
                      <span className="i-absent">pending</span>
                    )}
                  </td>
                  <td data-label="Transactions">
                    {probe.signatures.length > 0 ? (
                      probe.signatures.map((s) => (
                        <span key={s.signature} className="i-probe-tx">
                          <Addr address={s.signature} href={explorer('tx', s.signature, DEVNET)} />
                          <span className="i-entry-label"> {s.label}</span>
                        </span>
                      ))
                    ) : (
                      <span className="i-absent">pending: not sent yet</span>
                    )}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="i-empty">
                  No probe is listed in the deployment record.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="i-foot">
        The probe rows come from the repository&rsquo;s deployment record, <code>{record.file}</code>, which every
        devnet script appends to. The state above them is read from chain.
        {record.deploySignature ? (
          <>
            {' '}
            The program was deployed by{' '}
            <Addr address={record.deploySignature} href={explorer('tx', record.deploySignature, DEVNET)} />
            {record.deploySlot !== null ? `, slot ${record.deploySlot.toLocaleString('en-US')}` : ''}.
          </>
        ) : null}
      </p>
    </div>
  );
}
