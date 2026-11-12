import type { RecipientView, RiskLevel } from "@/lib/types";

/**
 * Reported counterparties.
 *
 * The verdict and its reasons are computed by the contract, not here: the same
 * `classify` the payment path runs. A badge the UI derived on its own could
 * disagree with what the chain does, which would be worse than showing nothing.
 */
const RISK: Record<RiskLevel, { bg: string; ink: string; icon: string; label: string }> = {
  blocked: { bg: "var(--critical)", ink: "#ffffff", icon: "✕", label: "Blocked" },
  warn: { bg: "var(--warning)", ink: "#0b0b0b", icon: "!", label: "Warn" },
  known: { bg: "var(--good)", ink: "#0b0b0b", icon: "✓", label: "Known" },
};

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  const s = RISK[risk] ?? RISK.warn;
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-semibold whitespace-nowrap"
      style={{ background: s.bg, color: s.ink }}
    >
      <span aria-hidden="true">{s.icon}</span>
      {s.label}
    </span>
  );
}

export function CounterpartyPanel({
  flagged,
  threshold,
}: {
  flagged: RecipientView[];
  threshold: number;
}) {
  if (flagged.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--text-secondary)" }}>
        No recipient has been reported. Anyone can file a report against an account; it takes{" "}
        {threshold} independent reporters to block one outright.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {flagged.map((r) => (
        <div
          key={r.account_id}
          className="rounded-lg border p-3"
          style={{ borderColor: "var(--border)", background: "var(--surface)" }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <code className="text-sm font-medium break-all">{r.account_id}</code>
            <RiskBadge risk={r.risk} />
          </div>

          <ul className="mt-2 flex flex-col gap-1">
            {r.reasons.map((reason, i) => (
              <li key={i} className="text-sm" style={{ color: "var(--text-secondary)" }}>
                {reason}
              </li>
            ))}
          </ul>

          <div
            className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs"
            style={{ color: "var(--text-secondary)" }}
          >
            <span>
              {r.distinct_reporters} of {threshold} reporters needed to block
            </span>
            <span>paid {r.times_paid}× by this vault</span>
            {r.blocklisted && <span>on the owner&apos;s blocklist</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

export default CounterpartyPanel;
