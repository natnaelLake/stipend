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
  rpcUrl: string;
  explorerTxBase: string;
  vaultId: string;
  agentId: string;
  agentKey: string;
  merchantId: string;
  attackerId: string;
  strangerId: string;
  ownerId: string;
  ownerKey: string | undefined;
  anthropicKey: string | undefined;
  model: string;
}

const DEFAULT_RPC: Record<string, string> = {
  testnet: "https://test.rpc.fastnear.com",
  mainnet: "https://free.rpc.fastnear.com",
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

  return {
    network,
    rpcUrl: opt("NEAR_RPC_URL", DEFAULT_RPC[network] ?? DEFAULT_RPC.testnet!),
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
    ownerId: process.env.OWNER_ACCOUNT_ID!,
    ownerKey: process.env.OWNER_PRIVATE_KEY,
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    model: opt("ANTHROPIC_MODEL", "claude-opus-5-5"),
  };
}
