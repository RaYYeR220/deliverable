'use client';

import { useEffect, useState } from 'react';

import { CLUSTER, CLUSTER_LABEL, PROGRAM_ID, solscan } from '@/lib/config';
import { utcMinute } from '@/lib/format';
import type { SeriesSnapshot } from '@/lib/types';

import { Addr } from './segments';
import { useWallets } from './wallet';

type Load = { state: 'idle' } | { state: 'reading' } | { state: 'read'; value: SeriesSnapshot } | { state: 'failed'; error: string };

export function SeriesPanel() {
  const [load, setLoad] = useState<Load>(PROGRAM_ID ? { state: 'reading' } : { state: 'idle' });
  const { wallets, connection, error, connect, disconnect } = useWallets();

  useEffect(() => {
    if (!PROGRAM_ID) return;
    let cancelled = false;
    fetch('/api/series', { cache: 'no-store' })
      .then(async (response) => {
        const body = (await response.json()) as SeriesSnapshot | { error: string };
        if (!response.ok || 'error' in body) throw new Error('error' in body ? body.error : `HTTP ${response.status}`);
        if (!cancelled) setLoad({ state: 'read', value: body });
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoad({ state: 'failed', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const deployed = load.state === 'read' && load.value.configured && load.value.deployed;
  const disabledReason = !PROGRAM_ID
    ? 'The program is not deployed yet, so there is nothing to write against or exercise.'
    : load.state === 'read' && load.value.configured && !load.value.deployed
      ? `No program is deployed at ${PROGRAM_ID} on ${CLUSTER_LABEL[CLUSTER]}.`
      : load.state === 'failed'
        ? 'The series could not be read, so nothing can be written or exercised from here.'
        : !connection
          ? 'Connect a wallet to write or exercise.'
          : 'Signing from this page is not wired to the deployment yet; the SDK builds every instruction unsigned.';

  return (
    <div className="i-series">
      <p className="i-series-state" role="status">
        {!PROGRAM_ID ? (
          <>
            The program is not deployed yet, so there are no series to list, write or exercise. The flow is shown here,
            disabled, until it is.
          </>
        ) : load.state === 'reading' ? (
          <>Reading series from the program&hellip;</>
        ) : load.state === 'failed' ? (
          <>The series could not be read: {load.error}</>
        ) : load.state === 'read' && load.value.configured && !load.value.deployed ? (
          <>
            No executable program at <Addr address={PROGRAM_ID} href={solscan('account', PROGRAM_ID, CLUSTER)} /> on{' '}
            {CLUSTER_LABEL[CLUSTER]}. Nothing can be listed until it is deployed.
          </>
        ) : (
          <>
            Series under <Addr address={PROGRAM_ID} href={solscan('account', PROGRAM_ID, CLUSTER)} /> on{' '}
            {CLUSTER_LABEL[CLUSTER]}, each with the strike it carries now.
          </>
        )}
      </p>

      <div className="i-wallet">
        <p className="i-wallet-head">Wallet</p>
        {connection ? (
          <p className="i-wallet-line">
            {connection.wallet.name} &middot;{' '}
            <Addr address={connection.account.address} href={solscan('account', connection.account.address, CLUSTER)} />{' '}
            <button type="button" className="i-reread" onClick={() => void disconnect()}>
              Disconnect
            </button>
          </p>
        ) : wallets.length > 0 ? (
          <p className="i-wallet-line">
            {wallets.map((w) => (
              <button key={w.name} type="button" className="i-reread" onClick={() => void connect(w)}>
                Connect {w.name}
              </button>
            ))}
          </p>
        ) : (
          <p className="i-wallet-line i-quiet">
            No Solana wallet has announced itself in this browser. None is needed to read anything on this page.
          </p>
        )}
        {error ? <p className="i-down-inline">The wallet declined: {error}</p> : null}
      </div>

      <div className="i-table-wrap">
        <table className="i-table i-series-table">
          <caption className="visually-hidden">Option series and their current adjusted strike</caption>
          <thead>
            <tr>
              <th scope="col">Series</th>
              <th scope="col">Underlying</th>
              <th scope="col">Expiry</th>
              <th scope="col" className="num">
                Strike at writing
              </th>
              <th scope="col" className="num">
                Strike now
              </th>
              <th scope="col" className="num">
                Shares per contract
              </th>
              <th scope="col">Phase</th>
            </tr>
          </thead>
          <tbody>
            {deployed && load.state === 'read' && load.value.configured && load.value.deployed && load.value.series.length > 0 ? (
              load.value.series.map((s) => (
                <tr key={s.address}>
                  <th scope="row" data-label="Series">
                    <Addr address={s.address} href={solscan('account', s.address, CLUSTER)} />
                  </th>
                  <td data-label="Underlying">
                    {s.symbol} {s.kind.toLowerCase()}
                  </td>
                  <td data-label="Expiry">{utcMinute(s.expiryTs)}</td>
                  <td data-label="Strike at writing" className="num">
                    {s.strike0} USDC
                  </td>
                  <td data-label="Strike now" className="num i-strong">
                    {s.strike} USDC
                  </td>
                  <td data-label="Shares per contract" className="num">
                    {s.uiSize}
                  </td>
                  <td data-label="Phase">{s.phase ?? 'unknown'}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={7} className="i-empty">
                  {deployed && load.state === 'read' && load.value.configured && load.value.deployed
                    ? `No series have been written on ${load.value.securities.join(' or ')} yet.`
                    : 'No series: nothing is deployed to hold one.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="i-actions">
        <button type="button" className="i-action" aria-disabled="true" aria-describedby="series-disabled">
          Write a covered call
        </button>
        <button type="button" className="i-action" aria-disabled="true" aria-describedby="series-disabled">
          Exercise
        </button>
        <p id="series-disabled" className="i-actions-why">
          {disabledReason}
        </p>
      </div>
    </div>
  );
}
