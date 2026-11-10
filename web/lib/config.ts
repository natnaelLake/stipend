/**
 * Defaults point at the live demo vault on purpose: a judge opening the hosted
 * URL, or cloning and running `npm run dev`, sees real on-chain data with zero
 * configuration.
 */
export const CONFIG = {
  contractId:
    process.env.NEXT_PUBLIC_VAULT_CONTRACT_ID ?? "vault.warden-demo.testnet",
  network: (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet") as "testnet" | "mainnet",
  rpcUrl: process.env.NEXT_PUBLIC_NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
} as const;

export const EXPLORER_TX =
  CONFIG.network === "mainnet"
    ? "https://nearblocks.io/txns/"
    : "https://testnet.nearblocks.io/txns/";

export const EXPLORER_ACCOUNT =
  CONFIG.network === "mainnet"
    ? "https://nearblocks.io/address/"
    : "https://testnet.nearblocks.io/address/";

/** How often the dashboard re-reads the chain. */
export const POLL_MS = 4000;
