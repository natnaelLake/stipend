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

/**
 * Normalise whatever the RPC threw into the protocol's own reason.
 *
 * near-api-js surfaces these as human sentences rather than the enum names, so
 * map both. Anything unrecognised is returned verbatim — and in particular an
 * "insufficient balance" refusal must NOT be mistaken for a permission denial,
 * because that would let the scenario claim a proof it has not made.
 */
function describeFailure(err: unknown): string {
  const text =
    err instanceof Error
      ? `${err.message}${"cause" in err && err.cause ? ` / ${JSON.stringify(err.cause)}` : ""}`
      : JSON.stringify(err);

  const patterns: Array<[RegExp, string]> = [
    [/MethodNameMismatch|does not allow method/i, "MethodNameMismatch"],
    [/ReceiverMismatch|does not allow (the )?receiver/i, "ReceiverMismatch"],
    [/DepositWithFunctionCall|deposit is not allowed with function call/i, "DepositWithFunctionCall"],
    [/RequiresFullAccess|requires full access|full access key/i, "RequiresFullAccess"],
    [/NotEnoughAllowance|not enough allowance/i, "NotEnoughAllowance"],
    [/AccessKeyNotFound|access key .* not found/i, "AccessKeyNotFound"],
    // Deliberately named so it can never be read as a permission denial.
    [/not enough balance/i, "InsufficientBalance (NOT a permission denial)"],
  ];
  for (const [re, name] of patterns) if (re.test(text)) return name;
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
      // 0.1 NEAR, well inside the agent's balance: if this is refused it can
      // only be because the key may not sign a Transfer action.
      label: `send 0.1 NEAR straight to ${env.attackerId}`,
      expect: "RequiresFullAccess",
      why: "a transfer is not a function call, so this key cannot sign it",
      go: (c) => c.transferRaw(env.attackerId, near.toYocto("0.1")),
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
      console.log();
      console.log(`  ${a.label}`);
      if (reason === a.expect) {
        ui.blocked(`refused by the protocol: ${reason}`);
        ui.note(a.why);
      } else {
        // Being refused is not enough; it has to be refused for the right
        // reason, or this scenario is proving nothing.
        ui.fail(`refused for the WRONG reason: ${reason} (expected ${a.expect})`);
        allRefused = false;
      }
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
