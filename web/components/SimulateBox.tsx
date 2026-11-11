"use client";

import { useState } from "react";
import { parseNear } from "@/lib/format";
import { view } from "@/lib/rpc";
import type { AgentView, PaymentDecision } from "@/lib/types";
import { DecisionBadge } from "./ui";

/**
 * Lets anyone test the policy without running an agent or signing anything.
 *
 * This calls the same `simulate_payment` view the agent uses, which shares the
 * policy engine with `request_payment` — so what it shows is what the chain
 * would actually do, not a re-implementation that could drift.
 */
export default function SimulateBox({
  agents,
  suggestedRecipient,
}: {
  agents: AgentView[];
  suggestedRecipient?: string;
}) {
  const [agent, setAgent] = useState(agents[0]?.account_id ?? "");
  const [recipient, setRecipient] = useState(suggestedRecipient ?? "");
  const [amount, setAmount] = useState("50");
  const [result, setResult] = useState<PaymentDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setError(null);
    setResult(null);
    const yocto = parseNear(amount);
    if (!yocto) {
      setError("Enter an amount in NEAR, e.g. 0.5");
      return;
    }
    if (!recipient.trim()) {
      setError("Enter a recipient account id");
      return;
    }
    setBusy(true);
    try {
      setResult(
        await view<PaymentDecision>("simulate_payment", {
          agent: agent || agents[0]?.account_id,
          recipient: recipient.trim(),
          amount: yocto,
        }),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const inputStyle = {
    background: "var(--surface-2)",
    borderColor: "var(--border)",
    color: "var(--text-primary)",
  };

  return (
    <div className="card p-4">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_120px_auto] sm:items-end">
        <label className="block">
          <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Agent
          </span>
          <select
            className="focusable mono w-full rounded-md border px-2 py-1.5 text-sm"
            style={inputStyle}
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          >
            {agents.map((a) => (
              <option key={a.account_id} value={a.account_id}>
                {a.account_id}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Recipient
          </span>
          <input
            className="focusable mono w-full rounded-md border px-2 py-1.5 text-sm"
            style={inputStyle}
            value={recipient}
            placeholder="attacker.stipend-demo.testnet"
            onChange={(e) => setRecipient(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void run()}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>
            Amount (NEAR)
          </span>
          <input
            className="focusable mono w-full rounded-md border px-2 py-1.5 text-sm"
            style={inputStyle}
            value={amount}
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void run()}
          />
        </label>

        <button
          className="focusable rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--text-primary)", color: "var(--surface-1)" }}
          onClick={() => void run()}
          disabled={busy}
        >
          {busy ? "Checking…" : "Test"}
        </button>
      </div>

      {error && (
        <p className="mt-3 text-sm" style={{ color: "var(--critical)" }}>
          {error}
        </p>
      )}

      {result && (
        <div
          className="mt-3 flex flex-wrap items-center gap-3 rounded-md p-3"
          style={{ background: "var(--surface-2)" }}
        >
          <DecisionBadge decision={result.decision} />
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {result.reason}
          </span>
          {result.agent_frozen && (
            <span className="text-xs font-semibold" style={{ color: "var(--serious)" }}>
              this attempt would freeze the agent
            </span>
          )}
        </div>
      )}

      <p className="mt-3 text-xs" style={{ color: "var(--text-muted)" }}>
        Read-only. Runs the vault&rsquo;s own policy engine — the same code path{" "}
        <span className="mono">request_payment</span> takes — so this is exactly what would happen.
      </p>
    </div>
  );
}
