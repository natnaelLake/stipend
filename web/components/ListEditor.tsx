"use client";

import { useState } from "react";
import { shortAccount } from "@/lib/format";
import type { OwnerActions } from "@/lib/owner";

export default function ListEditor({
  kind,
  entries,
  owner,
}: {
  kind: "allowlist" | "blocklist";
  entries: string[];
  owner?: OwnerActions;
}) {
  const [draft, setDraft] = useState("");
  const accent = kind === "allowlist" ? "var(--good)" : "var(--critical)";
  const addMethod = kind === "allowlist" ? "add_to_allowlist" : "add_to_blocklist";
  const removeMethod = kind === "allowlist" ? "remove_from_allowlist" : "remove_from_blocklist";

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: accent }} aria-hidden="true" />
        <h3 className="text-sm font-semibold capitalize">{kind}</h3>
        <span className="text-xs" style={{ color: "var(--text-muted)" }}>
          {entries.length}
        </span>
      </div>

      {entries.length === 0 ? (
        <p className="text-xs" style={{ color: "var(--text-muted)" }}>
          empty
        </p>
      ) : (
        <ul className="space-y-1">
          {entries.map((id) => (
            <li key={id} className="flex items-center justify-between gap-2">
              <span className="mono truncate text-xs" title={id}>
                {shortAccount(id)}
              </span>
              {owner?.isOwner && (
                <button
                  className="focusable shrink-0 text-xs underline-offset-2 hover:underline disabled:opacity-50"
                  style={{ color: "var(--text-muted)" }}
                  disabled={owner.busy !== null}
                  onClick={() => owner.call(removeMethod, { account_id: id })}
                >
                  remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {owner?.isOwner && (
        <div className="mt-3 flex gap-2">
          <input
            className="focusable mono min-w-0 flex-1 rounded-md border px-2 py-1 text-xs"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--border)",
              color: "var(--text-primary)",
            }}
            placeholder="account.testnet"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            className="focusable rounded-md border px-2 py-1 text-xs font-medium disabled:opacity-50"
            style={{ borderColor: "var(--border)" }}
            disabled={owner.busy !== null || draft.trim() === ""}
            onClick={async () => {
              await owner.call(addMethod, { account_id: draft.trim() });
              setDraft("");
            }}
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
