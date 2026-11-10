import { CONFIG } from "./config";

/**
 * View calls go straight to a public RPC with fetch — no SDK, no indexer, and
 * no wallet. That is what lets the dashboard show live data to anyone who
 * opens the URL.
 *
 * Public endpoints rate-limit, so we keep a list and stick to whichever one
 * last answered, rotating only on failure.
 */
function toBase64(s: string): string {
  if (typeof window === "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

export class RpcError extends Error {}

let current = 0;

export function activeRpc(): string {
  return CONFIG.rpcUrls[current % CONFIG.rpcUrls.length]!;
}

async function once<T>(
  url: string,
  method: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "warden",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: CONFIG.contractId,
        method_name: method,
        args_base64: toBase64(JSON.stringify(args)),
      },
    }),
  });

  if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${url}`);
  const json = await res.json();

  // Rate limits and node errors arrive as a JSON-RPC error, not an HTTP error.
  if (json.error) {
    throw new RpcError(json.error.data?.toString() ?? json.error.message ?? "RPC error");
  }
  // A contract panic surfaces here rather than as a transport error.
  if (json.result?.error) throw new RpcError(String(json.result.error));

  const bytes: number[] = json.result?.result ?? [];
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
}

export async function view<T>(
  method: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CONFIG.rpcUrls.length; attempt++) {
    const url = CONFIG.rpcUrls[(current + attempt) % CONFIG.rpcUrls.length]!;
    try {
      const result = await once<T>(url, method, args, signal);
      current = (current + attempt) % CONFIG.rpcUrls.length; // stick to what works
      return result;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new RpcError(String(lastError));
}
