"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { POLL_MS } from "./config";
import { view } from "./rpc";
import type { VaultSnapshot } from "./types";

const LOG_LIMIT = 40;

/**
 * One `get_dashboard` call rather than nine separate views: nine would be nine
 * round trips against a public RPC's rate limit every poll, and could straddle
 * blocks — showing a balance from one block beside a log from another.
 */
function readAll(signal: AbortSignal): Promise<VaultSnapshot> {
  return view<VaultSnapshot>("get_dashboard", { log_limit: LOG_LIMIT }, signal);
}

export interface VaultState {
  data: VaultSnapshot | null;
  error: string | null;
  /** True only for the very first load, so polling never blanks the screen. */
  loading: boolean;
  lastUpdated: number | null;
  refresh: () => void;
}

export function useVault(): VaultState {
  const [data, setData] = useState<VaultSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  const mounted = useRef(true);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;

    const run = async () => {
      try {
        const snapshot = await readAll(controller.signal);
        if (!mounted.current) return;
        setData(snapshot);
        setError(null);
        setLastUpdated(Date.now());
      } catch (e) {
        if (controller.signal.aborted || !mounted.current) return;
        // Keep showing the last good snapshot; a dropped poll is not a reason
        // to blank a dashboard someone is watching.
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mounted.current) timer = setTimeout(run, POLL_MS);
      }
    };

    void run();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [tick]);

  return { data, error, loading: data === null && error === null, lastUpdated, refresh };
}
