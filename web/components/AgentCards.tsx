import { EXPLORER_ACCOUNT } from "@/lib/config";
import { nearLabel, pctOf } from "@/lib/format";
import type { AgentView } from "@/lib/types";
import type { OwnerActions } from "@/lib/owner";
import { Empty, Meter } from "./ui";

export default function AgentCards({
  agents,
  owner,
}: {
  agents: AgentView[];
  owner?: OwnerActions;
}) {
  if (agents.length === 0) return <Empty>No agents registered on this vault yet.</Empty>;

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {agents.map((a) => {
        const used = pctOf(a.spent_in_window, a.daily_limit);
        const tone = used >= 90 ? "critical" : used >= 60 ? "warning" : "good";
        const strikeTone =
          a.strikes === 0 ? "good" : a.strikes >= a.strike_limit ? "critical" : "warning";

        return (
          <div key={a.account_id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{a.label}</div>
                <a
                  href={`${EXPLORER_ACCOUNT}${a.account_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mono focusable truncate text-xs underline-offset-2 hover:underline"
                  style={{ color: "var(--text-muted)" }}
                >
                  {a.account_id}
                </a>
              </div>
              {a.active ? (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold"
                  style={{ background: "var(--good)", color: "#0b0b0b" }}
                >
                  <span aria-hidden="true">●</span> Active
                </span>
              ) : (
                <span
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold"
                  style={{ background: "var(--serious)", color: "#0b0b0b" }}
                >
                  <span aria-hidden="true">❄</span> Frozen
                </span>
              )}
            </div>

            <div className="mt-4">
              <div className="mb-1.5 flex items-baseline justify-between text-xs">
                <span style={{ color: "var(--text-secondary)" }}>Spent today</span>
                <span className="mono">
                  {nearLabel(a.spent_in_window)} / {nearLabel(a.daily_limit)}
                </span>
              </div>
              <Meter pct={used} tone={tone} />
            </div>

            <div className="mt-3 flex items-center justify-between text-xs">
              <span style={{ color: "var(--text-secondary)" }}>
                Strikes{" "}
                <span
                  className="mono font-semibold"
                  style={{
                    color:
                      strikeTone === "critical"
                        ? "var(--critical)"
                        : strikeTone === "warning"
                          ? "var(--serious)"
                          : "var(--text-primary)",
                  }}
                >
                  {a.strikes}/{a.strike_limit}
                </span>
              </span>
              <span style={{ color: "var(--text-secondary)" }}>
                Rate <span className="mono">{a.tx_in_hour}/{a.max_tx_per_hour}</span> per hour
              </span>
            </div>

            {owner?.isOwner && (
              <div className="mt-4 flex gap-2">
                {a.active ? (
                  <button
                    className="focusable rounded-md border px-2.5 py-1 text-xs font-medium disabled:opacity-50"
                    style={{ borderColor: "var(--border)" }}
                    disabled={owner.busy !== null}
                    onClick={() => owner.call("freeze_agent", { account_id: a.account_id })}
                  >
                    {owner.busy === "freeze_agent" ? "Freezing…" : "Freeze"}
                  </button>
                ) : (
                  <button
                    className="focusable rounded-md px-2.5 py-1 text-xs font-semibold disabled:opacity-50"
                    style={{ background: "var(--good)", color: "#0b0b0b" }}
                    disabled={owner.busy !== null}
                    onClick={() => owner.call("unfreeze_agent", { account_id: a.account_id })}
                  >
                    {owner.busy === "unfreeze_agent" ? "Unfreezing…" : "Unfreeze"}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
