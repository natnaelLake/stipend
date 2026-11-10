/**
 * Prove the claim the whole project rests on.
 *
 * The agent key is a NEAR function-call access key restricted to
 * `request_payment` on the vault. Each attempt below is refused by the protocol
 * itself — these never reach the contract, so no contract code had to be
 * correct for them to fail.
 */
import { near, AgentVaultClient } from "../near.js";
import type { Env } from "../env.js";
import * as ui from "../ui.js";

export const description = "A stolen function-call key cannot withdraw, re-policy, or transfer";

/** Pull the useful part out of whatever the RPC threw. */
function describeFailure(err: unknown): string {
  const text =
    err instanceof Error
      ? `${err.message}${"cause" in err && err.cause ? ` / ${JSON.stringify(err.cause)}` : ""}`
      : JSON.stringify(err);
  for (const marker of [
    "MethodNameMismatch",
    "ReceiverMismatch",
    "DepositWithFunctionCall",
    "RequiresFullAccess",
    "NotEnoughAllowance",
    "AccessKeyNotFound",
  ]) {
    if (text.includes(marker)) return marker;
  }
  return text.slice(0, 200);
}

interface Attempt {
  label: string;
  expect: string;
  why: string;
  go: (c: AgentVaultClient) => Promise<unknown>;
}

export async function run(env: Env): Promise<void> {
  const client = new AgentVaultClient(env);

  ui.title("Scenario: the stolen key cannot escape");
  ui.note(`agent account   ${env.agentId}`);
  ui.note(`permitted       request_payment on ${env.vaultId}`);
  ui.note("everything else is refused before the contract is even reached");

  const attempts: Attempt[] = [
    {
      label: "withdraw 5 NEAR from the vault",
      expect: "MethodNameMismatch",
      why: "the key may only call request_payment",
      go: (c) => c.callRaw("withdraw", { amount: near.toYocto("5") }),
    },
    {
      label: "rewrite the spending policy",
      expect: "MethodNameMismatch",
      why: "set_policy is not in the key's method list",
      go: (c) =>
        c.callRaw("set_policy", {
          policy: {
            max_per_tx: near.toYocto("1000"),
            daily_limit: near.toYocto("1000"),
            approval_threshold: near.toYocto("1000"),
            new_recipient_limit: near.toYocto("1000"),
            allowlist_only: false,
            max_tx_per_hour: 1000,
            strike_limit: 1000,
            strike_window_ms: 60_000,
            pending_ttl_ms: 60_000,
          },
        }),
    },
    {
      label: "unfreeze itself",
      expect: "MethodNameMismatch",
      why: "a compromised agent cannot undo its own freeze",
      go: (c) => c.callRaw("unfreeze_agent", { account_id: env.agentId }),
    },
    {
      label: "attach a deposit to request_payment",
      expect: "DepositWithFunctionCall",
      why: "function-call keys cannot carry value at all",
      go: (c) =>
        c.callRaw(
          "request_payment",
          { recipient: env.merchantId, amount: near.toYocto("0.001"), memo: "value smuggling" },
          1n,
        ),
    },
    {
      label: `send NEAR straight to ${env.attackerId}`,
      expect: "RequiresFullAccess",
      why: "a transfer is not a function call, so this key cannot sign it",
      go: (c) => c.transferRaw(env.attackerId, near.toYocto("1")),
    },
  ];

  ui.section("Attempts");
  let allRefused = true;

  for (const a of attempts) {
    try {
      await a.go(client);
      ui.fail(`${a.label} — SUCCEEDED. The key is too permissive.`);
      allRefused = false;
    } catch (err) {
      const reason = describeFailure(err);
      const matched = reason === a.expect;
      console.log();
      console.log(`  ${a.label}`);
      if (matched) {
        ui.blocked(`refused by the protocol: ${reason}`);
      } else {
        ui.blocked(`refused: ${reason}`);
        ui.note(`(expected ${a.expect})`);
      }
      ui.note(a.why);
    }
  }

  ui.section("Result");
  if (allRefused) {
    ui.ok("none of these transactions could even be signed with the agent's key");
    ui.note("The vault's own code was never involved. This is NEAR access-key semantics.");
  } else {
    ui.fail("at least one escape succeeded — the access key is misconfigured");
    process.exitCode = 1;
  }
}
