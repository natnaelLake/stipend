"use client";

import { useEffect, useState } from "react";
import { formatNear, msToHuman, nearLabel, parseNear } from "@/lib/format";
import type { Policy } from "@/lib/types";
import type { OwnerActions } from "@/lib/owner";
import { Field } from "./ui";

const NEAR_FIELDS = [
  ["max_per_tx", "Max per transaction", "Hard cap on any single payment"],
  ["daily_limit", "Daily limit", "Per agent, rolling 24 hours"],
  ["approval_threshold", "Needs approval above", "Larger payments wait for you"],
  ["new_recipient_limit", "New recipient limit", "Unknown recipients above this wait for you"],
] as const;

export default function PolicyPanel({ policy, owner }: { policy: Policy; owner?: OwnerActions }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => toDraft(policy));
  const [error, setError] = useState<string | null>(null);

  // Keep the form in step with the chain whenever we are not mid-edit.
  useEffect(() => {
    if (!editing) setDraft(toDraft(policy));
  }, [policy, editing]);

  const save = async () => {
    setError(null);
    const next: Record<string, unknown> = {};
    for (const [key] of NEAR_FIELDS) {
      const yocto = parseNear(draft[key]);
      if (!yocto) {
        setError(`${key} must be a NEAR amount, e.g. 2 or 0.5`);
        return;
      }
      next[key] = yocto;
    }
    const nums = {
      max_tx_per_hour: Number(draft.max_tx_per_hour),
      strike_limit: Number(draft.strike_limit),
      strike_window_ms: Number(draft.strike_window_ms),
      pending_ttl_ms: Number(draft.pending_ttl_ms),
    };
    if (Object.values(nums).some((n) => !Number.isFinite(n) || n <= 0)) {
      setError("Rate limit, strike limit and the windows must all be positive numbers");
      return;
    }
    try {
      await owner!.call("set_policy", {
        policy: { ...next, ...nums, allowlist_only: draft.allowlist_only },
      });
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const inputStyle = {
    background: "var(--surface-2)",
    borderColor: "var(--border)",
    color: "var(--text-primary)",
  };

  if (!editing) {
    return (
      <div className="card p-4">
        <div style={{ borderBottom: "1px solid var(--border)" }} className="pb-2">
          {NEAR_FIELDS.map(([key, label, hint]) => (
            <div key={key}>
              <Field label={label}>{nearLabel(policy[key])}</Field>
              <div className="-mt-1 mb-1 text-xs" style={{ color: "var(--text-muted)" }}>
                {hint}
              </div>
            </div>
          ))}
        </div>
        <div className="pt-2">
          <Field label="Rate limit">{policy.max_tx_per_hour} / hour</Field>
          <Field label="Auto-freeze after">
            {policy.strike_limit} rejections in {msToHuman(policy.strike_window_ms)}
          </Field>
          <Field label="Pending expires after">{msToHuman(policy.pending_ttl_ms)}</Field>
          <Field label="Allowlist only">{policy.allowlist_only ? "yes" : "no"}</Field>
        </div>
        {owner?.isOwner && (
          <button
            className="focusable mt-3 w-full rounded-md border px-3 py-1.5 text-sm font-medium"
            style={{ borderColor: "var(--border)" }}
            onClick={() => setEditing(true)}
          >
            Edit policy
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="space-y-2">
        {NEAR_FIELDS.map(([key, label]) => (
          <label key={key} className="block">
            <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              {label} (NEAR)
            </span>
            <input
              className="focusable mono w-full rounded-md border px-2 py-1.5 text-sm"
              style={inputStyle}
              value={draft[key]}
              inputMode="decimal"
              onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
            />
          </label>
        ))}

        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              Payments / hour
            </span>
            <input
              className="focusable mono w-full rounded-md border px-2 py-1.5 text-sm"
              style={inputStyle}
              value={draft.max_tx_per_hour}
              inputMode="numeric"
              onChange={(e) => setDraft({ ...draft, max_tx_per_hour: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              Freeze after N strikes
            </span>
            <input
              className="focusable mono w-full rounded-md border px-2 py-1.5 text-sm"
              style={inputStyle}
              value={draft.strike_limit}
              inputMode="numeric"
              onChange={(e) => setDraft({ ...draft, strike_limit: e.target.value })}
            />
          </label>
        </div>

        <label className="flex items-center gap-2 pt-1 text-sm">
          <input
            type="checkbox"
            className="focusable"
            checked={draft.allowlist_only}
            onChange={(e) => setDraft({ ...draft, allowlist_only: e.target.checked })}
          />
          Allowlist only (reject every unknown recipient outright)
        </label>
      </div>

      {error && (
        <p className="mt-3 text-sm" style={{ color: "var(--critical)" }}>
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <button
          className="focusable flex-1 rounded-md px-3 py-1.5 text-sm font-semibold disabled:opacity-50"
          style={{ background: "var(--text-primary)", color: "var(--surface-1)" }}
          disabled={owner?.busy !== null}
          onClick={() => void save()}
        >
          {owner?.busy === "set_policy" ? "Saving…" : "Save policy"}
        </button>
        <button
          className="focusable rounded-md border px-3 py-1.5 text-sm font-medium"
          style={{ borderColor: "var(--border)" }}
          onClick={() => {
            setEditing(false);
            setError(null);
            setDraft(toDraft(policy));
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function toDraft(p: Policy) {
  return {
    max_per_tx: formatNear(p.max_per_tx, 24),
    daily_limit: formatNear(p.daily_limit, 24),
    approval_threshold: formatNear(p.approval_threshold, 24),
    new_recipient_limit: formatNear(p.new_recipient_limit, 24),
    max_tx_per_hour: String(p.max_tx_per_hour),
    strike_limit: String(p.strike_limit),
    strike_window_ms: String(p.strike_window_ms),
    pending_ttl_ms: String(p.pending_ttl_ms),
    allowlist_only: p.allowlist_only,
  };
}
