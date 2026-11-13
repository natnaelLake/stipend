import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// The repo-root .env is the single source of truth, shared with the dashboard.
// An agent-local .env may override it for experiments.
config({ path: resolve(here, "../../.env"), quiet: true });
config({ path: resolve(here, "../.env"), override: true, quiet: true });

export interface Env {
  network: string;
  /** Tried in order; the first one that answers is used for the whole run. */
  rpcUrls: string[];
  rpcUrl: string;
  explorerTxBase: string;
  vaultId: string;
  agentId: string;
  agentKey: string;
  merchantId: string;
  attackerId: string;
  strangerId: string;
  vendorId: string;
  vendor2Id: string;
  ownerId: string;
  ownerKey: string | undefined;
  anthropicKey: string | undefined;
  model: string;
  /** OpenRouter (or any OpenAI-compatible endpoint) key; preferred when set. */
  openrouterKey: string | undefined;
  openrouterModel: string;
}

// Public RPCs go down, rate-limit, and get deprecated without warning, so the
// demo never depends on one. NEAR_RPC_URL overrides the list entirely.
//
// The agent SENDS transactions, so the order here differs from the dashboard's
// (web/lib/config.ts), which only reads. drpc answers view calls happily but
// has been observed returning "Internal server error" on broadcast, so it sits
// second: a usable fallback for reads, not the first choice for writes.
const DEFAULT_RPC: Record<string, string[]> = {
  testnet: ["https://test.rpc.fastnear.com", "https://near-testnet.drpc.org"],
  mainnet: ["https://free.rpc.fastnear.com", "https://near.drpc.org"],
};

const DEFAULT_EXPLORER: Record<string, string> = {
  testnet: "https://testnet.nearblocks.io/txns/",
  mainnet: "https://nearblocks.io/txns/",
};

function opt(name: string, fallback: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

/**
 * Read and validate configuration. Throws one error listing everything that is
 * missing rather than failing on the first one, so a half-configured .env
 * produces a single actionable message.
 */
export function loadEnv(): Env {
  const network = opt("NEAR_NETWORK", "testnet");
  const needed = [
    "VAULT_CONTRACT_ID",
    "AGENT_ACCOUNT_ID",
    "AGENT_FC_PRIVATE_KEY",
    "MERCHANT_ACCOUNT_ID",
    "ATTACKER_ACCOUNT_ID",
    "OWNER_ACCOUNT_ID",
  ];
  const missing = needed.filter((n) => !process.env[n]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required settings: ${missing.join(", ")}\n` +
        `Copy .env.example to .env, or run ./scripts/setup-testnet.sh to create everything on testnet.`,
    );
  }

  const override = process.env.NEAR_RPC_URL;
  const rpcUrls =
    override === undefined || override === ""
      ? (DEFAULT_RPC[network] ?? DEFAULT_RPC.testnet!)
      : [override];

  return {
    network,
    rpcUrls,
    rpcUrl: rpcUrls[0]!,
    explorerTxBase: opt(
      "NEAR_EXPLORER_TX_BASE",
      DEFAULT_EXPLORER[network] ?? DEFAULT_EXPLORER.testnet!,
    ),
    vaultId: process.env.VAULT_CONTRACT_ID!,
    agentId: process.env.AGENT_ACCOUNT_ID!,
    agentKey: process.env.AGENT_FC_PRIVATE_KEY!,
    merchantId: process.env.MERCHANT_ACCOUNT_ID!,
    attackerId: process.env.ATTACKER_ACCOUNT_ID!,
    strangerId: opt("STRANGER_ACCOUNT_ID", process.env.MERCHANT_ACCOUNT_ID!),
    vendorId: opt("VENDOR_ACCOUNT_ID", ""),
    vendor2Id: opt("VENDOR2_ACCOUNT_ID", ""),
    ownerId: process.env.OWNER_ACCOUNT_ID!,
    ownerKey: process.env.OWNER_PRIVATE_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    model: opt("ANTHROPIC_MODEL", "claude-opus-5-5"),
    openrouterKey: process.env.OPENROUTER_API_KEY,
    openrouterModel: opt("OPENROUTER_MODEL", "anthropic/claude-sonnet-5.5"),
  };
}

/**
 * Pick the first RPC that actually answers, and pin the whole run to it.
 *
 * Probing once up front beats failing over mid-scenario: a scenario that
 * switched endpoints halfway could read state from two different nodes and
 * report a difference that is an artefact of the switch, not of the vault.
 */
export async function resolveRpc(env: Env): Promise<Env> {
  if (env.rpcUrls.length === 1) return env;

  const failures: string[] = [];
  for (const url of env.rpcUrls) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }),
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { result?: unknown };
        if (!body.result) throw new Error("no result in status response");
      } finally {
        clearTimeout(timer);
      }
      return { ...env, rpcUrl: url };
    } catch (err) {
      failures.push(`  ${url} -> ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`No NEAR RPC endpoint responded:\n${failures.join("\n")}`);
}
