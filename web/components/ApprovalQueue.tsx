import { EXPLORER_ACCOUNT } from "@/lib/config";
import { nearLabel, shortAccount, timeAgo } from "@/lib/format";
import type { PendingPayment } from "@/lib/types";
import type { OwnerActions } from "@/lib/owner";
import { Empty } from "./ui";

export default function ApprovalQueue({
  pending,
  owner,
}: {
  pending: PendingPayment[];
  owner?: OwnerActions;
}) {
  if (pending.length === 0) {
    return <Empty>Nothing waiting for approval.</Empty>;
  }

  return (
    <div className="space-y-3">
      {pending.map((p) => (
        <div
          key={p.id}
          className="card p-4"
          style={{ borderLeft: "3px solid var(--warning)" }}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="mono text-lg font-semibold">{nearLabel(p.amount)}</span>
                <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
                  to
                </span>
                <a
                  href={`${EXPLORER_ACCOUNT}${p.recipient}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mono focusable text-sm underline-offset-2 hover:underline"
                  title={p.recipient}
                >
                  {shortAccount(p.recipient)}
                </a>
              </div>
              <div className="mt-1 text-sm">{p.memo}</div>
              <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                {p.reason} · requested by{" "}
                <span className="mono">{shortAccount(p.agent)}</span> · {timeAgo(p.created_ms)}
              </div>
            </div>

            {owner?.isOwner ? (
              <div className="flex shrink-0 gap-2">
                <button
                  className="focusable rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
                  style={{ background: "var(--good)", color: "#0b0b0b" }}
                  disabled={owner.busy !== null}
                  onClick={() => owner.call("approve_pending", { id: p.id })}
                >
                  {owner.busy === "approve_pending" ? "Approving…" : "Approve"}
                </button>
                <button
                  className="focusable rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
                  style={{ background: "var(--critical)", color: "#ffffff" }}
                  disabled={owner.busy !== null}
                  onClick={() => owner.call("reject_pending", { id: p.id })}
                >
                  {owner.busy === "reject_pending" ? "Rejecting…" : "Reject"}
                </button>
              </div>
            ) : (
              <span className="shrink-0 text-xs" style={{ color: "var(--text-muted)" }}>
                connect the owner wallet to decide
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
