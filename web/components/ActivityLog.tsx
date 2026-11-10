import { EXPLORER_ACCOUNT } from "@/lib/config";
import { clockTime, nearLabel, shortAccount, timeAgo } from "@/lib/format";
import type { LogEntry } from "@/lib/types";
import { DecisionBadge, Empty } from "./ui";

export default function ActivityLog({ log }: { log: LogEntry[] }) {
  if (log.length === 0) {
    return <Empty>Nothing has happened on this vault yet.</Empty>;
  }

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left text-xs uppercase tracking-wide"
              style={{ color: "var(--text-muted)", borderBottom: "1px solid var(--border)" }}
            >
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Decision</th>
              <th className="px-4 py-2 text-right font-medium">Amount</th>
              <th className="px-4 py-2 font-medium">Recipient</th>
              <th className="px-4 py-2 font-medium">Why</th>
            </tr>
          </thead>
          <tbody>
            {log.map((e) => (
              <tr key={e.id} style={{ borderTop: "1px solid var(--border)" }}>
                <td className="whitespace-nowrap px-4 py-2 align-top">
                  <div className="mono text-xs">{clockTime(e.ts_ms)}</div>
                  <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {timeAgo(e.ts_ms)}
                  </div>
                </td>
                <td className="px-4 py-2 align-top">
                  <DecisionBadge decision={e.decision} />
                </td>
                <td className="mono whitespace-nowrap px-4 py-2 text-right align-top">
                  {e.amount === "0" ? (
                    <span style={{ color: "var(--text-muted)" }}>—</span>
                  ) : (
                    nearLabel(e.amount)
                  )}
                </td>
                <td className="px-4 py-2 align-top">
                  <a
                    href={`${EXPLORER_ACCOUNT}${e.recipient}`}
                    target="_blank"
                    rel="noreferrer"
                    className="mono focusable text-xs underline-offset-2 hover:underline"
                    style={{ color: "var(--text-secondary)" }}
                    title={e.recipient}
                  >
                    {shortAccount(e.recipient)}
                  </a>
                  {e.memo && (
                    <div className="mt-0.5 text-xs" style={{ color: "var(--text-muted)" }}>
                      {e.memo}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2 align-top text-xs" style={{ color: "var(--text-secondary)" }}>
                  {e.reason}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
