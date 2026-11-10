/** A legitimate purchase that is simply too large to approve unsupervised. */
import { near, AgentVaultClient, OwnerVaultClient } from "../near.js";
import type { Env } from "../env.js";
import * as ui from "../ui.js";
import { showLog, showVaultState, waitForSettlement } from "./common.js";

export const description = "A large but legitimate payment waits for the owner";

export async function run(env: Env): Promise<void> {
  const client = new AgentVaultClient(env);

  ui.title("Scenario: large purchase needs a human");
  await showVaultState(client);

  ui.section("Payment");
  const amountYocto = near.toYocto("1.5");
  const result = await client.requestPayment(
    env.merchantId,
    amountYocto,
    "annual api plan renewal",
  );
  ui.paymentLine("annual api plan renewal", env.merchantId, amountYocto, result);

  if (result.decision !== "pending") {
    ui.fail(`expected this to be held for the owner, got ${result.decision}: ${result.reason}`);
    process.exitCode = 1;
    return;
  }

  ui.section("Approval queue");
  for (const p of await client.getPending()) {
    ui.kv(`#${p.id}`, `${near.fmt(p.amount)} → ${p.recipient}`);
    ui.kv("", `${p.memo} — ${p.reason}`);
  }

  if (!env.ownerKey) {
    ui.note("");
    ui.note("No OWNER_PRIVATE_KEY in .env, so stopping here.");
    ui.note("Approve it in the dashboard, or set OWNER_PRIVATE_KEY to let this script do it.");
    return;
  }

  ui.section("Owner approves");
  const owner = new OwnerVaultClient(env, env.ownerKey);
  const pendingId = result.pending_id!;
  await owner.approvePending(pendingId);
  ui.ok(`owner released pending #${pendingId}`);

  const log = await client.getRecentLog(1);
  const approvalLogId = log[0]?.id;
  if (approvalLogId) {
    const settled = await waitForSettlement(client, approvalLogId);
    if (settled?.decision === "executed") ui.ok(`transfer settled: ${settled.reason}`);
    else if (settled) ui.fail(`transfer ${settled.decision}: ${settled.reason}`);
  }

  await showLog(client, 8);
}
