'use client';

import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import {
  StandardConnect,
  StandardDisconnect,
  StandardEvents,
  type StandardConnectFeature,
  type StandardDisconnectFeature,
  type StandardEventsFeature,
} from '@wallet-standard/features';
import { useCallback, useEffect, useState } from 'react';

/**
 * Wallet Standard discovery and connection, with no adapter layer: every wallet that
 * registers itself on the page and speaks a Solana chain is listed by its own name.
 */

const SOLANA_CHAIN = /^solana:/;

function isSolanaWallet(wallet: Wallet): boolean {
  return wallet.chains.some((c) => SOLANA_CHAIN.test(c)) && StandardConnect in wallet.features;
}

export interface Connection {
  wallet: Wallet;
  account: WalletAccount;
}

export function useWallets() {
  const [wallets, setWallets] = useState<readonly Wallet[]>([]);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = getWallets();
    const refresh = () => setWallets(api.get().filter(isSolanaWallet));
    refresh();
    const offRegister = api.on('register', refresh);
    const offUnregister = api.on('unregister', refresh);
    return () => {
      offRegister();
      offUnregister();
    };
  }, []);

  // Follow the wallet if the user switches or revokes the account from its own interface.
  useEffect(() => {
    if (!connection || !(StandardEvents in connection.wallet.features)) return;
    const events = (connection.wallet.features as StandardEventsFeature)[StandardEvents];
    return events.on('change', ({ accounts }) => {
      if (!accounts) return;
      const next = accounts.find((a) => a.chains.some((c) => SOLANA_CHAIN.test(c)));
      setConnection(next ? { wallet: connection.wallet, account: next } : null);
    });
  }, [connection]);

  const connect = useCallback(async (wallet: Wallet) => {
    setError(null);
    try {
      const { accounts } = await (wallet.features as StandardConnectFeature)[StandardConnect].connect();
      const account = accounts.find((a) => a.chains.some((c) => SOLANA_CHAIN.test(c))) ?? accounts[0];
      if (!account) throw new Error(`${wallet.name} returned no account`);
      setConnection({ wallet, account });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const disconnect = useCallback(async () => {
    if (!connection) return;
    const feature = (connection.wallet.features as Partial<StandardDisconnectFeature>)[StandardDisconnect];
    setConnection(null);
    try {
      await feature?.disconnect();
    } catch {
      // the page has already forgotten the account; a wallet that refuses to hear it is not our state
    }
  }, [connection]);

  return { wallets, connection, error, connect, disconnect };
}
