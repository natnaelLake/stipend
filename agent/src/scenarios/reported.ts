/**
 * Counterparty risk: a recipient nobody has blocklisted, but that other people
 * have reported.
 *
 * The owner of this vault has never heard of the account. That is the normal
 * case — an agent meets counterparties its owner has not vetted. A blocklist
 * only the owner can write is no help there, so reporting is open to anyone,
 * and the threshold plus the bond are what stop that openness being abused.
 */
import { ReporterClient, AgentVaultClient, OwnerVaultClient, near } from "../near.js";
import type { Env } from "../env.js";
import * as ui from "../ui.js";
import { showLog, showVaultState } from "./common.js";

export const description = "An account other people reported is stopped before the owner ever hears of it";

export async function run(env: Env): Promise<void> {
  const client = new AgentVaultClient(env);

  ui.title("Scenario: reported counterparty");
  await showVaultState(client);

  const target = env.strangerId;
  const policy = await client.getPolicy();

  // Reports persist, so a second run would start from the end state of the
  // first. Clear them up front, the same way reset-demo.sh does, so this can
  // be run repeatedly — including between takes while filming.
  const existing = await client.getRecipient(target);
  if (existing.distinct_reporters > 0) {
    if (!env.ownerKey) {
      throw new Error(
        `${target} already has ${existing.distinct_reporters} report(s) and OWNER_PRIVATE_KEY is not set, ` +
          `so this scenario cannot reset itself. Run: near contract call-function as-transaction ` +
          `${client.contractId} clear_reports ...`,
      );
    }
    await new OwnerVaultClient(env, env.ownerKey).clearReports(target);
    ui.note(`cleared ${existing.distinct_reporters} existing report(s) so this run starts clean`);
  }

  ui.section("Before any reports");
  const before = await client.getRecipient(target);
  ui.note(`${target} → ${before.risk.toUpperCase()}`);
  for (const r of before.reasons) ui.note(`  ${r}`);

  // A payment under new_recipient_limit to an unreported stranger is allowed.
  ui.section("A small payment to this stranger is allowed today");
  const dry = await client.simulatePayment(client.accountId, target, near.toYocto("0.1"));
  ui.note(`simulate 0.1 NEAR → ${dry.decision}: ${dry.reason}`);
  if (dry.decision !== "approved") {
    throw new Error(`expected the stranger to be payable before reports, got: ${dry.reason}`);
  }

  ui.section(`Two independent accounts report it (threshold is ${policy.report_block_threshold})`);

  const reporters: Array<[string, string]> = [
    [env.merchantId, process.env.MERCHANT_PRIVATE_KEY ?? ""],
    [env.attackerId, process.env.ATTACKER_PRIVATE_KEY ?? ""],
  ];

  let filed = 0;
  for (const [who, key] of reporters) {
    if (!key) {
      ui.note(`no key for ${who} in .env — skipping this reporter`);
      continue;
    }
    const reporter = new ReporterClient(env, who, key);
    try {
      await reporter.report(target, "fake-invoice", `https://example.invalid/evidence/${filed + 1}`);
      filed++;
      const now = await client.getRecipient(target);
      ui.note(`${who} filed a report → ${now.distinct_reporters} distinct reporter(s), risk ${now.risk}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("has already reported")) {
        ui.note(`${who} had already reported this account — counts once, by design`);
        filed++;
      } else {
        throw err;
      }
    }
  }

  ui.section("After the reports");
  const after = await client.getRecipient(target);
  ui.note(`${target} → ${after.risk.toUpperCase()}`);
  for (const r of after.reasons) ui.note(`  ${r}`);

  ui.section("The same payment now");
  const result = await client.requestPayment(target, near.toYocto("0.1"), "supplier invoice");
  ui.paymentLine("pay → supplier invoice", target, near.toYocto("0.1"), result);

  const expected = after.distinct_reporters >= policy.report_block_threshold ? "rejected" : "pending";
  if (result.decision !== expected) {
    throw new Error(
      `expected ${expected} with ${after.distinct_reporters} reporter(s), got ${result.decision}: ${result.reason}`,
    );
  }

  await showLog(client, 6);

  ui.section("Result");
  if (expected === "rejected") {
    ui.blocked(`blocked on chain: ${result.reason}`);
    ui.blocked("the owner never had to know this account existed");
  } else {
    ui.ok(`held for the owner: ${result.reason}`);
    ui.ok("one report warns; it takes the threshold to block outright");
  }
  ui.note("The dry-run above and this decision came from the same policy engine.");
}
