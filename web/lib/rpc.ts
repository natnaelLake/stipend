import { CONFIG } from "./config";

/**
 * View calls go straight to a public RPC with fetch — no SDK, no indexer, and
 * no wallet. That is what lets the dashboard show live data to anyone who
 * opens the URL.
 */
function toBase64(s: string): string {
  if (typeof window === "undefined") return Buffer.from(s, "utf8").toString("base64");
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

export class RpcError extends Error {}

export async function view<T>(
  method: string,
  args: Record<string, unknown> = {},
  signal?: AbortSignal,
): Promise<T> {
  const res = await fetch(CONFIG.rpcUrl, {
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

  if (!res.ok) throw new RpcError(`RPC HTTP ${res.status}`);
  const json = await res.json();

  if (json.error) {
    throw new RpcError(json.error.data?.toString() ?? json.error.message ?? "RPC error");
  }
  // A contract panic surfaces here rather than as a transport error.
  if (json.result?.error) throw new RpcError(String(json.result.error));

  const bytes: number[] = json.result?.result ?? [];
  const text = new TextDecoder().decode(new Uint8Array(bytes));
  return JSON.parse(text) as T;
}
