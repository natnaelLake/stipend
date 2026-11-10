"use client";

import "@near-wallet-selector/modal-ui/styles.css";

import { CONFIG, EXPLORER_ACCOUNT } from "@/lib/config";
import { nearLabel, shortAccount } from "@/lib/format";
import { useVault } from "@/lib/useVault";
import { useWallet } from "@/lib/useWallet";

import ActivityLog from "./ActivityLog";
import AgentCards from "./AgentCards";
import ApprovalQueue from "./ApprovalQueue";
import ListEditor from "./ListEditor";
import PolicyPanel from "./PolicyPanel";
import SimulateBox from "./SimulateBox";
import ThemeToggle from "./ThemeToggle";
import { Section, StatTile } from "./ui";

export default function Dashboard() {
  const { data, error, loading, lastUpdated, refresh } = useVault();
  const owner = useWallet(data?.owner, refresh);

  if (loading) {
    return (
      <main className="mx-auto max-w-6xl px-5 py-10">
        <p style={{ color: "var(--text-muted)" }}>Reading the vault from NEAR…</p>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="mx-auto max-w-6xl px-5 py-10">
        <div className="card p-6">
          <h1 className="text-lg font-semibold">Could not reach the vault</h1>
          <p className="mt-2 text-sm" style={{ color: "var(--text-secondary)" }}>
            {error}
          </p>
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
            Contract <span className="mono">{CONFIG.contractId}</span> via{" "}
            <span className="mono">{CONFIG.rpcUrl}</span>
          </p>
        </div>
      </main>
    );
  }

  const blockedCount = data.log.filter(
    (e) => e.decision === "rejected" || e.decision === "owner_rejected",
  ).length;
  const frozenCount = data.agents.filter((a) => !a.active).length;

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Warden</h1>
          <p className="mt-0.5 text-sm" style={{ color: "var(--text-secondary)" }}>
            Policy-enforced spending vault for AI agents
          </p>
          <a
            href={`${EXPLORER_ACCOUNT}${CONFIG.contractId}`}
            target="_blank"
            rel="noreferrer"
            className="mono focusable mt-1 inline-block text-xs underline-offset-2 hover:underline"
            style={{ color: "var(--text-muted)" }}
          >
            {CONFIG.contractId} ↗
          </a>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <span
            className="inline-flex items-center gap-1.5 text-xs"
            style={{ color: "var(--text-muted)" }}
            title={lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : undefined}
          >
            <span
              className="pulse-dot h-1.5 w-1.5 rounded-full"
              style={{ background: error ? "var(--serious)" : "var(--good)" }}
              aria-hidden="true"
            />
            {error ? "reconnecting" : "live"}
          </span>
          <ThemeToggle />
          {owner.accountId ? (
            <button
              className="focusable rounded-md border px-2.5 py-1 text-xs"
              style={{ borderColor: "var(--border)" }}
              onClick={owner.disconnect}
              title={owner.accountId}
            >
              {shortAccount(owner.accountId)} · disconnect
            </button>
          ) : (
            <button
              className="focusable rounded-md px-3 py-1 text-xs font-semibold disabled:opacity-50"
              style={{ background: "var(--text-primary)", color: "var(--surface-1)" }}
              onClick={owner.connect}
              disabled={!owner.ready}
            >
              Connect wallet
            </button>
          )}
        </div>
      </header>

      {/* Everything below is readable without a wallet. */}
      {!owner.accountId && (
        <div
          className="card mb-6 p-3 text-sm"
          style={{ color: "var(--text-secondary)", borderLeft: "3px solid var(--good)" }}
        >
          Read-only view of live testnet data. Connect the owner wallet (
          <span className="mono">{shortAccount(data.owner)}</span>) to approve payments, edit the
          policy or freeze an agent.
        </div>
      )}
      {owner.accountId && !owner.isOwner && (
        <div
          className="card mb-6 p-3 text-sm"
          style={{ color: "var(--text-secondary)", borderLeft: "3px solid var(--warning)" }}
        >
          Connected as <span className="mono">{owner.accountId}</span>, which is not the vault
          owner. Still read-only — the contract would reject owner calls from this account.
        </div>
      )}
      {owner.error && (
        <div
          className="card mb-6 p-3 text-sm"
          style={{ color: "var(--critical)", borderLeft: "3px solid var(--critical)" }}
        >
          {owner.error}
        </div>
      )}

      <div className="mb-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label="Available to spend"
          value={nearLabel(data.balance.available)}
          hint={`${nearLabel(data.balance.total)} held in total`}
        />
        <StatTile
          label="Vault status"
          value={data.paused ? "Paused" : "Active"}
          tone={data.paused ? "critical" : "good"}
          hint={data.paused ? "all payments rejected" : "accepting requests"}
        />
        <StatTile
          label="Waiting for you"
          value={String(data.pending.length)}
          unit={data.pending.length === 1 ? "payment" : "payments"}
          tone={data.pending.length > 0 ? "warning" : undefined}
        />
        <StatTile
          label="Blocked attempts"
          value={String(blockedCount)}
          unit="recent"
          tone={blockedCount > 0 ? "critical" : undefined}
          hint={frozenCount > 0 ? `${frozenCount} agent frozen` : "in the last 40 events"}
        />
      </div>

      {owner.isOwner && (
        <div className="mb-8">
          <button
            className="focusable w-full rounded-md px-4 py-2.5 text-sm font-semibold disabled:opacity-50"
            style={
              data.paused
                ? { background: "var(--good)", color: "#0b0b0b" }
                : { background: "var(--critical)", color: "#ffffff" }
            }
            disabled={owner.busy !== null}
            onClick={() => owner.call(data.paused ? "unpause" : "pause", {})}
          >
            {owner.busy === "pause" || owner.busy === "unpause"
              ? "Working…"
              : data.paused
                ? "Unpause the vault"
                : "Pause everything — stop all payments now"}
          </button>
        </div>
      )}

      <Section title="Agents" subtitle="Each agent holds only a function-call key to request_payment">
        <AgentCards agents={data.agents} owner={owner} />
      </Section>

      <Section
        title="Approval queue"
        subtitle="Payments the policy held back for a human decision"
      >
        <ApprovalQueue pending={data.pending} owner={owner} />
      </Section>

      <Section
        title="Test a payment"
        subtitle="Try the policy yourself — no wallet, no agent, nothing signed"
      >
        <SimulateBox agents={data.agents} suggestedRecipient={data.blocklist[0]} />
      </Section>

      <Section title="Activity log" subtitle="Append-only, written by the contract itself">
        <ActivityLog log={data.log} />
      </Section>

      <Section title="Policy" subtitle="Enforced on chain, not by the agent">
        <div className="grid gap-3 lg:grid-cols-3">
          <div className="lg:col-span-1">
            <PolicyPanel policy={data.policy} owner={owner} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:col-span-2 lg:grid-cols-2">
            <ListEditor kind="allowlist" entries={data.allowlist} owner={owner} />
            <ListEditor kind="blocklist" entries={data.blocklist} owner={owner} />
          </div>
        </div>
      </Section>

      <footer className="mt-10 text-xs" style={{ color: "var(--text-muted)" }}>
        Built at NEAR HACKATHON · the agent never holds funds or a full-access key
      </footer>
    </main>
  );
}
