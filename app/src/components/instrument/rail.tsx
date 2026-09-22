'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';

import { CLUSTER, CLUSTER_LABEL, DEVNET_LIVE, explorer, PROGRAM_ID, PROGRAM_ID_INVALID, SECURITIES, solscan } from '@/lib/config';
import { etTime, span, utc } from '@/lib/format';
import type { BasisView, DevnetRecord, RailSnapshot, ReplayData } from '@/lib/types';

import { Basis } from './basis';
import { DevnetTablet } from './devnet';
import { GateTablet } from './gate-tablet';
import { Addr } from './segments';

type Mode = 'live' | 'preview' | 'replay';

const POLL_MS = 30_000;
// Preview opens first even when a deployment exists: it runs the whole gate against the real
// AAPLx and NVDAx mints on mainnet, which is what the venue is for. Live is one click away and
// is the proof that the deployed program rules the same way.
const DEFAULT_MODE: Mode = 'preview';

function modeFromUrl(): Mode | null {
  const value = new URLSearchParams(window.location.search).get('mode');
  if (value === 'replay' || value === 'preview') return value;
  if (value === 'live' && PROGRAM_ID) return 'live';
  return null;
}

export function Rail({ replay, devnet }: { replay: ReplayData; devnet: DevnetRecord | null }) {
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);
  const [snapshot, setSnapshot] = useState<RailSnapshot | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<BasisView | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [reading, setReading] = useState(false);
  const inflight = useRef<AbortController | null>(null);

  useEffect(() => {
    const fromUrl = modeFromUrl();
    if (fromUrl) setMode(fromUrl);
  }, []);

  const choose = (next: Mode) => {
    if (next === 'live' && !PROGRAM_ID) return;
    setMode(next);
    const url = new URL(window.location.href);
    if (next === DEFAULT_MODE) url.searchParams.delete('mode');
    else url.searchParams.set('mode', next);
    window.history.replaceState(null, '', url);
  };

  const read = useCallback(async (target: 'live' | 'preview') => {
    inflight.current?.abort();
    const controller = new AbortController();
    inflight.current = controller;
    setReading(true);
    try {
      const response = await fetch(`/api/rail?mode=${target}`, { signal: controller.signal, cache: 'no-store' });
      const body = (await response.json()) as RailSnapshot | { error: string };
      if (!response.ok || 'error' in body) {
        throw new Error('error' in body ? body.error : `the server answered HTTP ${response.status}`);
      }
      setSnapshot(body);
      setFailure(null);
      if (body.basis.ok) {
        const basis = body.basis.value;
        setAnchor((prev) => prev ?? basis);
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (inflight.current === controller) {
        inflight.current = null;
        setReading(false);
      }
    }
  }, []);

  // Poll while a live mode is showing and the tab is visible. Replay never reads the network.
  useEffect(() => {
    if (mode === 'replay') return;
    setSnapshot((prev) => (prev && prev.mode === mode ? prev : null));
    setAnchor(null);
    void read(mode);
    let timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read(mode);
    }, POLL_MS);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearInterval(timer);
      void read(mode);
      timer = window.setInterval(() => {
        if (document.visibilityState === 'visible') void read(mode);
      }, POLL_MS);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      inflight.current?.abort();
    };
  }, [mode, read]);

  // A one-second tick for "read 12 s ago"; it never touches a displayed measurement.
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const current = mode === 'replay' ? null : snapshot && snapshot.mode === mode ? snapshot : null;
  // Live against a devnet deployment reads that program's own state instead of the
  // mainnet gates: the mainnet securities are not registered under it.
  const onDevnet = mode === 'live' && DEVNET_LIVE && devnet !== null;
  const devnetState = onDevnet ? (current?.devnet ?? null) : null;
  const gates = mode === 'replay' ? replay.gates : SECURITIES.map((s) => current?.gates.find((g) => g.symbol === s.symbol) ?? { symbol: s.symbol, mint: s.mint, result: null });
  const basis = mode === 'replay' ? replay.basis : (current?.basis ?? null);
  const chainClock = current?.gates.find((g) => g.result?.ok)?.result;
  const nothingRead =
    current !== null &&
    !current.basis.ok &&
    (onDevnet ? !current.devnet?.ok : current.gates.every((g) => !g.result.ok));
  const clock =
    mode === 'replay'
      ? replay.clock
      : devnetState?.ok
        ? devnetState.value.chainClock
        : chainClock && chainClock.ok
          ? chainClock.value.evaluatedAt
          : current?.basis.ok
            ? current.basis.value.at
            : null;

  const modeWord = mode === 'replay' ? 'REPLAY' : mode === 'live' ? 'LIVE' : 'PREVIEW';

  return (
    <>
      <p className="architrave">
        <Link href="/" prefetch={false}>
          DELIVERABLE
        </Link>{' '}
        &middot; THE INSTRUMENT &middot; {modeWord}
        {mode === 'replay'
          ? ` · ${utc(replay.clock).toUpperCase()}`
          : ` · ${CLUSTER_LABEL[mode === 'live' ? CLUSTER : 'mainnet-beta'].toUpperCase()}`}
      </p>

      <div className="i-modebar">
        <div className="i-modes" role="group" aria-label="Mode">
          <button
            type="button"
            className="i-mode"
            aria-pressed={mode === 'live'}
            aria-disabled={!PROGRAM_ID}
            onClick={() => choose('live')}
          >
            <span className="i-mode-name">Live</span>
            <span className="i-mode-sub">{PROGRAM_ID ? `${CLUSTER_LABEL[CLUSTER]}` : 'no deployment yet'}</span>
          </button>
          <button type="button" className="i-mode" aria-pressed={mode === 'preview'} onClick={() => choose('preview')}>
            <span className="i-mode-name">Preview</span>
            <span className="i-mode-sub">mainnet now, program defaults</span>
          </button>
          <button type="button" className="i-mode" aria-pressed={mode === 'replay'} onClick={() => choose('replay')}>
            <span className="i-mode-name">Replay</span>
            <span className="i-mode-sub">Sunday 2026-09-20</span>
          </button>
        </div>

        <p className="i-mode-line" aria-live="polite">
          {mode === 'live' && onDevnet ? (
            <>
              <strong>Live &middot; devnet.</strong> The program at{' '}
              <Addr address={PROGRAM_ID ?? ''} href={explorer('address', PROGRAM_ID ?? '', 'devnet')} /> on Solana
              devnet, read now from its own accounts: the SecurityState it wrote, the stand-in mint it is registered
              against, the registry and the devnet chain clock. The verdict below is not recomputed here &mdash; it is
              the refusal code the program itself recorded on chain.
            </>
          ) : mode === 'live' ? (
            <>
              <strong>Live.</strong> The program at{' '}
              <Addr address={PROGRAM_ID ?? ''} href={solscan('account', PROGRAM_ID ?? '', CLUSTER)} /> on{' '}
              {CLUSTER_LABEL[CLUSTER]}, read now. Every input comes from its accounts: the security, its calendar, the
              mint, the Scope account and the chain clock. Nothing is staged.
            </>
          ) : mode === 'preview' ? (
            <>
              <strong>Preview.</strong>{' '}
              {DEVNET_LIVE
                ? 'The program is deployed on devnet, not on mainnet, so here the SDK runs its gate on the live mint, the live Scope prices and the chain clock, under the committed calendar and the program’s default tolerances.'
                : PROGRAM_ID
                  ? 'The gate on preview terms, for comparison with Live: the SDK runs it on the live mint, the live Scope prices and the chain clock, under the committed calendar and the program’s default tolerances.'
                  : 'The program is not deployed yet, so the SDK runs its gate on the live mint, the live Scope prices and the chain clock, under the committed calendar and the program’s default tolerances.'}{' '}
              Nothing is staged. The halt attestation is the one input a preview cannot observe.
            </>
          ) : (
            <>
              <strong>Replay.</strong> The gate against the Scope account and the mints as recorded from mainnet, with
              the clock set to {utc(replay.clock)} ({etTime(replay.clock)}), Sunday 2026-09-20. What runs here is the
              SDK&rsquo;s TypeScript port of the gate, not the compiled program. The compiled program runs against the
              same Scope and AAPLx bytes in the LiteSVM tests, and a drift test pins the port to the program&rsquo;s
              check order and refusal codes.
            </>
          )}
        </p>

        {PROGRAM_ID_INVALID ? (
          <p className="i-down-inline">
            The configured program id is not a Solana address, so it is ignored and the instrument stays in Preview.
          </p>
        ) : null}

        <p className="i-clock">
          {mode === 'replay' ? (
            <>REPLAY CLOCK {utc(replay.clock)} &middot; {etTime(replay.clock).toUpperCase()}</>
          ) : clock !== null ? (
            <>
              {onDevnet ? 'DEVNET CHAIN CLOCK ' : 'CHAIN CLOCK '}
              {utc(clock)} &middot; {etTime(clock).toUpperCase()}
              {current && now !== null ? <> &middot; READ {span((now - current.readAt) / 1000).toUpperCase()} AGO</> : null}
            </>
          ) : failure || nothingRead ? (
            <>{onDevnet ? 'DEVNET NOT READ' : 'MAINNET NOT READ'} &middot; REPLAY NEEDS NO NETWORK</>
          ) : (
            <>{onDevnet ? 'READING DEVNET' : 'READING MAINNET'}</>
          )}
          {mode !== 'replay' ? (
            <button type="button" className="i-reread" onClick={() => void read(mode)} disabled={reading}>
              {reading ? 'Reading' : 'Read again'}
            </button>
          ) : null}
        </p>

        {failure && mode !== 'replay' ? (
          <p className="i-down-inline" role="status">
            The server could not read {onDevnet ? 'the deployment' : 'mainnet'}: {failure}. Nothing below is filled in
            from an older read.
          </p>
        ) : null}

        {mode === 'replay' ? (
          <details className="i-notes i-replayed">
            <summary>What is replayed</summary>
            <table className="i-table i-pinned">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Address</th>
                  <th scope="col">Bytes from</th>
                  <th scope="col">Captured</th>
                  <th scope="col">sha256</th>
                </tr>
              </thead>
              <tbody>
                {replay.accounts.map((a) => (
                  <tr key={a.file}>
                    <th scope="row" data-label="Account">
                      {a.what}
                    </th>
                    <td data-label="Address">
                      <Addr address={a.pubkey} href={solscan('account', a.pubkey)} />
                    </td>
                    <td data-label="Bytes from">
                      <code>{a.file}</code>
                    </td>
                    <td data-label="Captured">{a.captured}</td>
                    <td data-label="sha256">
                      <code title={a.sha256}>{a.sha256.slice(0, 16)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        ) : null}
      </div>

      <section id="gate" className="i-section" aria-labelledby="gate-title">
        <p className="sect-mark">I &middot; THE GATE</p>
        <h2 id="gate-title" className="cut">
          NINE&nbsp;<span className="dot">&middot;</span> CHECKS&nbsp;<span className="dot">&middot;</span> ONE&nbsp;
          <span className="dot">&middot;</span> ORDER
        </h2>
        {onDevnet && devnet ? (
          <DevnetTablet record={devnet} state={devnetState} />
        ) : (
          <div className="i-tablets">
            {gates.map((g) => (
              <GateTablet key={g.symbol} symbol={g.symbol} mint={g.mint} result={g.result} />
            ))}
          </div>
        )}
        <p className="i-foot i-gate-foot">
          {onDevnet ? (
            <>
              The program ran this order itself, on chain, in the same sequence: the calendar first because it is the
              cheapest check and the one that holds most of the week, the issuer&rsquo;s levers before any oracle is
              read. It wrote the first code that refused, and that is the code read back above.
            </>
          ) : (
            <>
              Each security is checked in the program&rsquo;s own order. The calendar runs first because it is the
              cheapest check and the one that holds most of the week; the issuer&rsquo;s levers run before any oracle is
              read. The first condition that fails is the code the program emits, and nothing after it is evaluated: the
              rows after it still show their values, marked not reached.
            </>
          )}
        </p>
      </section>

      <section id="basis" className="i-section" aria-labelledby="basis-title">
        <p className="sect-mark">II &middot; THE BASIS</p>
        <h2 id="basis-title" className="cut">
          THE&nbsp;<span className="dot">&middot;</span> FEED&nbsp;<span className="dot">&middot;</span> AGAINST&nbsp;
          <span className="dot">&middot;</span> THE&nbsp;<span className="dot">&middot;</span> MARKET
        </h2>
        <p className="i-intro">
          {mode === 'replay'
            ? 'The measurement as it was taken at 09:15 UTC that Sunday, an hour before the Scope account the gate replays was captured: the Scope entries tokenized-equity lending marks against, beside the price one share was trading at on chain, converted to the same unit with each mint’s multiplier.'
            : 'The Scope entries tokenized-equity lending marks against, beside the price one share is trading at on chain right now, converted to the same unit with each mint’s multiplier, read on the server the way scripts/measure-basis.py reads them.'}{' '}
          A feed can report itself seconds old while carrying a price that has not moved since the market closed.
          {onDevnet
            ? ' This measurement is mainnet, not devnet: devnet has no Scope account and no xStocks, so it is the same read Preview makes.'
            : ''}
        </p>
        <Basis result={basis} anchor={mode === 'replay' ? null : anchor} />
      </section>
    </>
  );
}
