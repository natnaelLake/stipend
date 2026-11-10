"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CONFIG } from "./config";
import type { OwnerActions } from "./owner";

const GAS = 100_000_000_000_000n; // 100 TGas
const ONE_YOCTO = 1n;

// Imported lazily: wallet-selector touches window at module scope, so it must
// never be pulled into the server render.
type Selector = Awaited<ReturnType<typeof import("@near-wallet-selector/core")["setupWalletSelector"]>>;
type Modal = ReturnType<typeof import("@near-wallet-selector/modal-ui")["setupModal"]>;

export function useWallet(ownerAccountId: string | undefined, onChanged: () => void): OwnerActions {
  const [ready, setReady] = useState(false);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectorRef = useRef<Selector | null>(null);
  const modalRef = useRef<Modal | null>(null);
  // v10 takes NAJ actions, which are built with the core's actionCreators.
  const coreRef = useRef<typeof import("@near-wallet-selector/core") | null>(null);

  useEffect(() => {
    let cancelled = false;
    let subscription: { unsubscribe: () => void } | undefined;

    (async () => {
      try {
        const [core, modalUi, myNearWallet, meteor] = await Promise.all([
          import("@near-wallet-selector/core"),
          import("@near-wallet-selector/modal-ui"),
          import("@near-wallet-selector/my-near-wallet"),
          import("@near-wallet-selector/meteor-wallet"),
        ]);

        const selector = await core.setupWalletSelector({
          network: CONFIG.network,
          modules: [myNearWallet.setupMyNearWallet(), meteor.setupMeteorWallet()],
        });
        if (cancelled) return;

        selectorRef.current = selector;
        coreRef.current = core;
        modalRef.current = modalUi.setupModal(selector, { contractId: CONFIG.contractId });

        const sync = (accounts: Array<{ accountId: string; active?: boolean }>) => {
          const active = accounts.find((a) => a.active) ?? accounts[0];
          setAccountId(active?.accountId ?? null);
        };
        sync(selector.store.getState().accounts);
        subscription = selector.store.observable.subscribe((state) => sync(state.accounts));

        setReady(true);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();

    return () => {
      cancelled = true;
      subscription?.unsubscribe();
    };
  }, []);

  const connect = useCallback(() => {
    setError(null);
    modalRef.current?.show();
  }, []);

  const disconnect = useCallback(async () => {
    try {
      const wallet = await selectorRef.current?.wallet();
      await wallet?.signOut();
    } catch {
      // Signing out of an already-gone session is not worth surfacing.
    }
    setAccountId(null);
  }, []);

  const call = useCallback(
    async (method: string, args: Record<string, unknown>) => {
      const selector = selectorRef.current;
      if (!selector) throw new Error("wallet is not ready yet");
      setBusy(method);
      setError(null);
      try {
        const wallet = await selector.wallet();
        // Every owner method asserts exactly 1 yoctoNEAR, which is what keeps
        // them out of reach of a function-call key.
        await wallet.signAndSendTransaction({
          receiverId: CONFIG.contractId,
          actions: [
            coreRef.current!.actionCreators.functionCall(method, args, GAS, ONE_YOCTO),
          ],
        });
        onChanged();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        throw e;
      } finally {
        setBusy(null);
      }
    },
    [onChanged],
  );

  return {
    ready,
    accountId,
    isOwner: accountId !== null && ownerAccountId !== undefined && accountId === ownerAccountId,
    busy,
    error,
    connect,
    disconnect: () => void disconnect(),
    call,
  };
}
