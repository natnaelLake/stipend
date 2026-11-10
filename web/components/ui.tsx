import type { Decision } from "@/lib/types";

/**
 * Status styling for a decision.
 *
 * Every status ships an icon AND a label — never colour alone. That is a hard
 * accessibility rule, and it also happens to be what makes the log readable in
 * a 1080p screen recording.
 */
const STATUS: Record<Decision, { bg: string; ink: string; icon: string; label: string }> = {
  approved:       { bg: "var(--good)",         ink: "#0b0b0b", icon: "✓", label: "Approved" },
  executed:       { bg: "var(--good)",         ink: "#0b0b0b", icon: "✓", label: "Executed" },
  owner_approved: { bg: "var(--good)",         ink: "#0b0b0b", icon: "✓", label: "Owner approved" },
  agent_unfrozen: { bg: "var(--good)",         ink: "#0b0b0b", icon: "↻", label: "Unfrozen" },
  pending:        { bg: "var(--warning)",      ink: "#0b0b0b", icon: "◷", label: "Pending" },
  agent_frozen:   { bg: "var(--serious)",      ink: "#0b0b0b", icon: "❄", label: "Agent frozen" },
  rejected:       { bg: "var(--critical)",     ink: "#ffffff", icon: "✕", label: "Rejected" },
  owner_rejected: { bg: "var(--critical)",     ink: "#ffffff", icon: "✕", label: "Owner rejected" },
  failed:         { bg: "var(--critical)",     ink: "#ffffff", icon: "⚠", label: "Failed" },
  expired:        { bg: "var(--neutral-chip)", ink: "var(--neutral-chip-ink)", icon: "⊘", label: "Expired" },
};

export function DecisionBadge({ decision }: { decision: Decision }) {
  const s = STATUS[decision] ?? STATUS.expired;
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

export function Section({
  title,
  subtitle,
  right,
  children,
}: {
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-8">
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold tracking-tight">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-sm" style={{ color: "var(--text-secondary)" }}>
              {subtitle}
            </p>
          )}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

/** A single headline number. Not a chart, by design. */
export function StatTile({
  label,
  value,
  unit,
  hint,
  tone,
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: "good" | "critical" | "warning";
}) {
  const toneColor =
    tone === "good" ? "var(--good)" : tone === "critical" ? "var(--critical)" : tone === "warning" ? "var(--warning)" : undefined;
  return (
    <div className="card p-4">
      <div className="text-xs font-medium uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>
        {label}
      </div>
      <div className="mt-1.5 flex items-baseline gap-1.5">
        <span className="mono text-2xl font-semibold" style={toneColor ? { color: toneColor } : undefined}>
          {value}
        </span>
        {unit && (
          <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
            {unit}
          </span>
        )}
      </div>
      {hint && (
        <div className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
          {hint}
        </div>
      )}
    </div>
  );
}

export function Meter({ pct, tone }: { pct: number; tone: "good" | "warning" | "critical" }) {
  const color = tone === "critical" ? "var(--critical)" : tone === "warning" ? "var(--warning)" : "var(--good)";
  return (
    <div className="meter h-2 w-full" role="presentation">
      <span style={{ width: `${Math.max(pct > 0 ? 2 : 0, pct)}%`, background: color }} />
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
        {label}
      </span>
      <span className="mono text-sm font-medium">{children}</span>
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="card p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
      {children}
    </div>
  );
}
