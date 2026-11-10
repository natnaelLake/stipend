import { near, type AgentVaultClient, type LogEntry } from "../near.js";
import * as ui from "../ui.js";

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Print the policy the vault is currently enforcing, plus the agent's budget. */
export async function showVaultState(client: AgentVaultClient): Promise<void> {
  const [policy, balance, agent, paused] = await Promise.all([
    client.getPolicy(),
    client.getBalance(),
    client.getAgent(client.accountId),
    client.isPaused(),
  ]);

  ui.section("Vault");
  ui.kv("contract", client.contractId);
  ui.kv("available balance", near.fmt(balance.available));
  ui.kv("paused", paused ? "yes" : "no");

  ui.section("Policy enforced on chain");
  ui.kv("max per transaction", near.fmt(policy.max_per_tx));
  ui.kv("daily limit", near.fmt(policy.daily_limit));
  ui.kv("needs approval above", near.fmt(policy.approval_threshold));
  ui.kv("new recipient limit", near.fmt(policy.new_recipient_limit));
  ui.kv("rate limit", `${policy.max_tx_per_hour} payments / hour`);
  ui.kv("auto-freeze after", `${policy.strike_limit} rejected attempts`);

  if (agent) {
    ui.section(`Agent ${agent.account_id}`);
    ui.kv("label", agent.label);
    ui.kv("status", agent.active ? "active" : "FROZEN");
    ui.kv("spent today", `${near.fmt(agent.spent_in_window)} of ${near.fmt(agent.daily_limit)}`);
    ui.kv("strikes", `${agent.strikes} of ${agent.strike_limit}`);
  }
}

/**
 * The approval and the transfer are separate receipts, so an approved payment
 * is only `executed` in the log a moment later. Poll for that entry rather than
 * claiming success the instant the call returns.
 */
export async function waitForSettlement(
  client: AgentVaultClient,
  afterLogId: string,
  timeoutMs = 25_000,
): Promise<LogEntry | undefined> {
  const deadline = Date.now() + timeoutMs;
  const after = BigInt(afterLogId);
  while (Date.now() < deadline) {
    const log = await client.getRecentLog(12);
    const hit = log.find(
      (e) => BigInt(e.id) > after && (e.decision === "executed" || e.decision === "failed"),
    );
    if (hit) return hit;
    await sleep(1500);
  }
  return undefined;
}

export async function showLog(client: AgentVaultClient, limit = 10): Promise<void> {
  ui.section(`Audit log (newest first, from the contract)`);
  ui.logTable(await client.getRecentLog(limit));
}
