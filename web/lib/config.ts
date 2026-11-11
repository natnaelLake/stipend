/**
 * Defaults point at the live demo vault on purpose: a judge opening the hosted
 * URL, or cloning and running `npm run dev`, sees real on-chain data with zero
 * configuration.
 */
const DEFAULT_RPCS: Record<string, string[]> = {
  // rpc.testnet.near.org is deprecated and now answers -429 with a notice to
  // move off it, so it is deliberately absent. Both of these were burst-tested
  // for rate limits and for a real Access-Control-Allow-Origin header, since a
  // server-side curl proves nothing about what a browser is allowed to do.
  testnet: ["https://near-testnet.drpc.org", "https://test.rpc.fastnear.com"],
  mainnet: ["https://free.rpc.fastnear.com", "https://near.drpc.org"],
};

const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet") as "testnet" | "mainnet";

export const CONFIG = {
  contractId:
    process.env.NEXT_PUBLIC_VAULT_CONTRACT_ID ?? "vault.stipend-demo.testnet",
  network: NETWORK,
  /** Tried in order; the first that answers is reused until it fails. */
  rpcUrls: process.env.NEXT_PUBLIC_NEAR_RPC_URL
    ? [process.env.NEXT_PUBLIC_NEAR_RPC_URL]
    : (DEFAULT_RPCS[NETWORK] ?? DEFAULT_RPCS.testnet!),
} as const;

/** First choice, for display. */
export const PRIMARY_RPC = CONFIG.rpcUrls[0]!;

export const EXPLORER_TX =
  CONFIG.network === "mainnet"
    ? "https://nearblocks.io/txns/"
    : "https://testnet.nearblocks.io/txns/";

export const EXPLORER_ACCOUNT =
  CONFIG.network === "mainnet"
    ? "https://nearblocks.io/address/"
    : "https://testnet.nearblocks.io/address/";

/** How often the dashboard re-reads the chain. */
export const POLL_MS = 5000;
