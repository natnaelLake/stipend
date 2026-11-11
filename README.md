# Stipend — a spending vault for AI agents on NEAR

AI agents are starting to hold money, and a single prompt injection can drain a
wallet. Stipend puts the money in a NEAR contract instead of in the agent. The
agent holds only a **function-call access key** that can call one method,
`request_payment`, and the contract checks every request against rules the
owner set. Approved payments execute, large ones wait for a human, and
malicious ones are blocked and logged — all on chain, so a compromised agent
cannot talk its way past them.

Built at **NEAR HACKATHON**. Tracks: `security` (primary), `agents`.

---

## Links

| | |
|---|---|
| **Contract (testnet)** | [`vault.stipend-demo.testnet`](https://testnet.nearblocks.io/address/vault.stipend-demo.testnet) |
| **Live dashboard** | **https://stipend-psi.vercel.app** — read-only, no wallet needed |
| **Demo video** | _not yet recorded_ |

> The video link must be filled in before submission.

---

## How it works

```
┌─────────────────────┐   function-call key (request_payment only)   ┌──────────────────────────┐
│  Agent runner (TS)  │ ───────────────────────────────────────────▶ │  Vault contract (Rust)   │
│  LLM + pay() tool   │                                              │  policy engine + funds   │
└─────────────────────┘                                              │  pending queue + log     │
                                                                     └──────────┬───────────────┘
┌─────────────────────┐   full-access wallet (owner signs)                      │ Promise::transfer
│ Dashboard (Next.js) │ ───────── set_policy / approve / pause ────────────────▶│
│  wallet selector    │ ◀──────── view calls (policy, log, queue) ──────────────┘
└─────────────────────┘                                               recipients (merchant.…, …)
```

The agent never holds the funds and never holds a full-access key. It asks; the
contract decides.

---

## Why NEAR

1. **Function-call access keys are a protocol feature, not a convention.** A key
   can be restricted to one contract and a named list of methods, and it cannot
   attach a deposit or carry a transfer. The agent's key is *physically unable*
   to move funds directly — this is enforced by the chain before a transaction
   is even accepted, so no contract code has to be correct for it to hold.
2. **Named accounts make agent identities readable.** `agent1.stipend-demo.testnet`
   is legible in an audit log in a way an ethereum-style address is not.
3. **The policy lives in the contract, not in the agent.** A prompt-injected or
   fully compromised agent runs into the same rules as a healthy one.

Point 1 is the load-bearing one, and it is proved by a test rather than
asserted — see [the function-call key proof](#the-function-call-key-proof).

---

## Quick verify — no setup, nothing to install

**Ask the live contract what it would do if the agent tried to send 50 NEAR to a
blocklisted account.** This is a read-only call against testnet; it needs no
account, no key and no wallet.

```bash
curl -s -X POST https://near-testnet.drpc.org -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"call_function","finality":"final","account_id":"vault.stipend-demo.testnet","method_name":"simulate_payment","args_base64":"eyJhZ2VudCI6ImFnZW50MS5zdGlwZW5kLWRlbW8udGVzdG5ldCIsInJlY2lwaWVudCI6ImF0dGFja2VyLnN0aXBlbmQtZGVtby50ZXN0bmV0IiwiYW1vdW50IjoiNTAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAifQ=="}}' | python3 -c "import sys,json;print(bytes(json.load(sys.stdin)['result']['result']).decode())"
```

You will see:

```json
{"decision":"rejected","reason":"recipient attacker.stipend-demo.testnet is blocklisted","pending_id":null,"log_id":null,"agent_frozen":false}
```

The `args_base64` above decodes to
`{"agent":"agent1.stipend-demo.testnet","recipient":"attacker.stipend-demo.testnet","amount":"50000000000000000000000000"}`.
`python3` is only there to turn the RPC's byte array into text — drop the pipe
and you get the same answer as a JSON array of bytes.

**Same thing with the NEAR CLI**, if you have it:

```bash
near contract call-function as-read-only vault.stipend-demo.testnet simulate_payment json-args '{"agent":"agent1.stipend-demo.testnet","recipient":"attacker.stipend-demo.testnet","amount":"50000000000000000000000000"}' network-config testnet now
```

**Read the whole vault — policy, agents, approval queue and audit log — in one call:**

```bash
near contract call-function as-read-only vault.stipend-demo.testnet get_dashboard json-args '{"log_limit":10}' network-config testnet now
```

The log will contain real blocked attacks: `exceeds max_per_tx`,
`recipient … is blocklisted`, `recipient is the agent itself`, and an
`agent_frozen` entry.

`simulate_payment` is not a re-implementation of the rules — it calls the same
policy engine `request_payment` does, so its answer is what would actually
happen. A unit test asserts the two agree.

---

## Run the tests

Needs only Rust. **No network, no accounts, no keys.**

```bash
cd contract && cargo test
```

→ `test result: ok. 39 passed; 0 failed`

Integration tests run a real NEAR node in a sandbox (downloads a sandbox binary
on first run, so this one does need network):

```bash
cargo test -p stipend-integration
```

→ `test result: ok. 6 passed; 0 failed`

**The first run takes about ten minutes and looks like it has hung — it has
not.** Each test compiles the contract to wasm and boots a NEAR sandbox node,
and on a cold checkout that work is not yet cached. A second run takes well
under a minute. It also downloads a sandbox binary, so unlike the unit tests
this one needs network.

`near-workspaces` lives in its own crate precisely so that `cd contract &&
cargo test` stays offline and fast.

### The function-call key proof

`cargo test -p stipend-integration function_call_key -- --nocapture` adds a
function-call key restricted to `request_payment`, confirms it can do its job,
then tries to abuse it. Each refusal asserts the *specific*
`InvalidAccessKeyError`, because a test that accepts any error would also pass
with a broken sandbox:

```
  set_policy (no deposit):             refused by the protocol — MethodNameMismatch
  withdraw (no deposit):               refused by the protocol — MethodNameMismatch
  unfreeze_agent (no deposit):         refused by the protocol — MethodNameMismatch
  request_payment with a deposit:      refused by the protocol — DepositWithFunctionCall
  request_payment against another account: refused by the protocol — ReceiverMismatch
  plain transfer:                      refused by the protocol — RequiresFullAccess
```

It also includes a positive control: the same `set_policy` succeeds with the
owner's full-access key, so the refusals are about the key and not the
environment.

---

## Run the whole thing yourself

### Prerequisites

| Tool | Built and tested with | Install |
|---|---|---|
| Rust (stable) | `1.99.1` (contract MSRV `1.93`) | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| wasm target | — | `rustup target add wasm32-unknown-unknown` |
| `cargo-near` | `0.23.0` | `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh \| sh` |
| `near-cli-rs` | `0.31.1` | `curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/near-cli-rs/releases/latest/download/near-cli-rs-installer.sh \| sh` |
| Node | `22.22.0` (20+ should work) | https://nodejs.org |

### Deploy your own vault on testnet

This creates **your own** accounts under a generated name like
`stipend-demo-a1b2c3.testnet`, so it does not collide with the demo above.

```bash
cd agent && npm install && npm run gen-keys && cd ..
./scripts/setup-testnet.sh
```

`gen-keys` writes a gitignored `.env` at the repo root with every account name
and key. `setup-testnet.sh` then builds the contract, creates the root account
from the testnet faucet, creates the sub-accounts, deploys and initialises the
vault, adds the agent's restricted key, and seeds the allowlist and blocklist.
Every step is idempotent and **every command is printed before it runs**; add
`--dry-run` to print without executing.

### Run the demo scenarios

```bash
cd agent
npm run scenario -- compromised
```

An attacker holds the agent's key and tries three different ways to drain the
vault. Expected output (abridged):

```
▸ Drain attempts

  1. Take everything at once
    → 15 NEAR to merchant.stipend-demo.testnet
     REJECTED   exceeds max_per_tx (requested 15.00 NEAR, cap 2.00 NEAR)

  2. Send it somewhere the owner blocked
    → 0.1 NEAR to attacker.stipend-demo.testnet
     REJECTED   recipient attacker.stipend-demo.testnet is blocklisted

  3. Pay the agent's own account and withdraw later
    → 0.1 NEAR to agent1.stipend-demo.testnet
     REJECTED   recipient is the agent itself
     AGENT FROZEN  strike limit reached — the vault cut this agent off

▸ After three strikes

  4. A completely legitimate payment the agent makes every day
    → 0.2 NEAR to merchant.stipend-demo.testnet
     REJECTED   agent frozen after 3 rejected attempts (strike_limit 3)

▸ Result
  ⛔ every drain attempt was rejected on chain, by the contract
  ⛔ the agent is now frozen and cannot pay anyone, not even merchant.stipend-demo.testnet
  ✓ not one yoctoNEAR left the vault: still 3.9481 NEAR
  (spendable balance dipped 0.0109 NEAR — on-chain storage for the new audit entries, not a payout)

  The agent's own code was never consulted. The policy is the contract's.
```

Account names and the balance figure will differ on your own deployment; the
decisions and the reasons are what should match exactly.

All five scenarios:

| Scenario | Needs an LLM? | What it shows |
|---|---|---|
| `compromised` | no | three drain shapes blocked, then auto-freeze |
| `key-escape` | no | the stolen key cannot withdraw, re-policy or transfer |
| `normal` | no | approved → executed, funds move, budget tracked |
| `big-purchase` | no | over the threshold → pending → owner approves → executed |
| `injection` | **yes** | a poisoned invoice tells the agent to pay an attacker |

`injection` needs `ANTHROPIC_API_KEY` in `.env`. The other four are
deterministic and reproduce identically every run — which is why the demo video
is built on `compromised`, not on `injection`.

Between takes, `./scripts/reset-demo.sh` unpauses the vault, unfreezes the
agent and clears the queue. It deliberately does **not** clear the audit log.

### Run the dashboard

```bash
cd web && npm install && npm run dev
```

Open http://localhost:3000. It defaults to the deployed demo vault, so it shows
live data with no configuration; point it at your own with
`NEXT_PUBLIC_VAULT_CONTRACT_ID` in `web/.env.local`.

The same build is hosted at **https://stipend-psi.vercel.app** if you would
rather just look at it.

Everything is readable **without a wallet**. Connecting the owner wallet
additionally enables approve/reject, pause, freeze/unfreeze, policy editing and
list editing.

---

## Contract API

| Method | Who can call it | What happens |
|---|---|---|
| `new(owner, policy)` | once, at deploy | initialises the vault |
| `request_payment(recipient, amount, memo)` | **registered agents** (function-call key) | evaluates the policy; returns `approved` / `pending` / `rejected` with a reason. Never panics on a policy violation |
| `on_transfer_complete(…)` | the contract itself (`#[private]`) | logs `executed`, or logs `failed` and refunds the reserved budget |
| `set_policy(policy)` | owner + 1 yocto | replaces the rules |
| `add_agent(account_id, label)` / `remove_agent` | owner + 1 yocto | registers / removes an agent |
| `freeze_agent` / `unfreeze_agent` | owner + 1 yocto | stops / restores an agent; unfreeze resets strikes |
| `add_to_allowlist` / `remove_from_allowlist` | owner + 1 yocto | edits the allowlist |
| `add_to_blocklist` / `remove_from_blocklist` | owner + 1 yocto | edits the blocklist |
| `approve_pending(id)` | owner + 1 yocto | releases a queued payment; charges it to the agent's daily budget |
| `reject_pending(id)` | owner + 1 yocto | drops a queued payment |
| `pause()` / `unpause()` | owner + 1 yocto | global kill switch |
| `withdraw(amount)` | owner + 1 yocto | moves funds back to the owner |
| `expire_pending()` | **anyone** | drops queued payments past their TTL. Safe to expose: it can only remove |
| `get_dashboard(log_limit)` | anyone (view) | the whole vault in one consistent snapshot |
| `simulate_payment(agent, recipient, amount)` | anyone (view) | dry-run; shares the policy engine with `request_payment` |
| `get_policy` `get_owner` `is_paused` `get_agents` `get_agent` `get_allowlist` `get_blocklist` `get_pending` `get_log` `get_recent_log` `get_log_len` `get_log_window` `get_balance` | anyone (view) | reads |

The 1 yoctoNEAR on every sensitive owner method is deliberate: a function-call
access key **cannot attach a deposit**, so those methods are unreachable from
the agent's key even if its method list were wrong.

---

## The policy, and the order it is applied

```rust
pub struct Policy {
    max_per_tx:          NearToken, // hard cap on one payment
    daily_limit:         NearToken, // per agent, rolling 24h
    approval_threshold:  NearToken, // above this → waits for the owner
    new_recipient_limit: NearToken, // unknown recipients above this → waits
    allowlist_only:      bool,      // if true, unknown recipients are rejected
    max_tx_per_hour:     u32,       // rolling hourly rate limit
    strike_limit:        u32,       // rejections before auto-freeze
    strike_window_ms:    u64,       // window the strikes accumulate in
    pending_ttl_ms:      u64,       // how long a queued payment survives
}
```

Rules are checked in a fixed order and **the first one that fires wins**, so the
`reason` string always names a single rule. This order is part of the public
contract: it is documented here, implemented once in `contract/src/policy.rs`,
and asserted by the tests.

| # | Rule | Outcome | Strike? |
|---|---|---|---|
| 1 | vault is paused | rejected | no |
| 2 | agent is frozen | rejected | no |
| 3 | recipient is blocklisted | rejected | **yes** |
| 4 | recipient is the vault or the agent itself | rejected | **yes** |
| 5 | `amount > max_per_tx` | rejected | **yes** |
| 6 | `spent_today + amount > daily_limit` | rejected | **yes** |
| 7 | `tx_this_hour + 1 > max_tx_per_hour` | rejected | **yes** |
| 8 | recipient not allowlisted, and `allowlist_only` | rejected | **yes** |
| 9 | recipient not allowlisted, `amount > new_recipient_limit` | **pending** | no |
| 10 | `amount > approval_threshold` | **pending** | no |
| 11 | not enough available balance | rejected | no (not the agent's fault) |
| — | otherwise | **approved**, budget reserved, transfer scheduled | — |

Reaching `strike_limit` strikes inside `strike_window_ms` freezes the agent.
Only the owner can unfreeze it, which also resets the strikes.

**A policy violation never panics.** A panic would revert state and erase the
audit log and the strike counter — precisely what an attacker would want. The
contract records the rejection, emits a NEP-297 event, and returns a verdict.
Panics are reserved for malformed input (zero amount, memo over 256 bytes) and
an unregistered caller.

The demo vault's policy: 2 NEAR per transaction, 5 NEAR per day, owner approval
above 1 NEAR, unknown recipients above 0.5 NEAR, 10 payments per hour, freeze
after 3 strikes in an hour.

---

## Security notes and limitations

Honest list.

- **Testnet only.** Nothing here has been deployed to mainnet or audited.
- **The function-call key is restricted, not harmless.** It can still call
  `request_payment` as often as the rate limit allows, and spend up to the
  policy's limits on allowlisted recipients. Stipend bounds the blast radius of
  a compromised agent; it does not make one safe.
- **The owner's full-access key is the real root of trust.** If it leaks, the
  attacker can rewrite the policy and withdraw. Stipend does not help there —
  use a hardware wallet or a multisig for the owner account.
- **The audit log is a bounded ring buffer** (2,000 entries). Older entries are
  dropped on chain. Anything needing permanent history should index the
  NEP-297 events off chain.
- **Log entries do not carry transaction hashes.** A contract cannot read its
  own transaction hash, so the dashboard links to the accounts involved rather
  than to the transaction.
- **Pending payments do not reserve budget** while queued. They are charged to
  the daily limit when the owner approves, so a queue full of approvals can be
  released only up to the limit.
- **`expire_pending` is callable by anyone.** It can only remove requests past
  their TTL, so there is nothing to gain by calling it.
- **Storage grows with the log**, and NEAR charges for storage. The vault's
  *spendable* balance therefore dips slightly as it records rejections. Keep it
  funded.
- **Single owner.** No multisig, no roles, no per-recipient limits yet.
- **The `injection` scenario is inherently non-deterministic.** Whether the
  model follows the injected instruction varies run to run — which is the
  reason enforcement is not left to the model, and the reason the demo video
  uses `compromised` instead.

### Not verified

- Signing owner actions **through a connected browser wallet** has not been
  exercised end to end; it needs a real wallet session. The owner methods
  themselves are covered by the integration tests and are called by
  `setup-testnet.sh` and `reset-demo.sh` via the CLI.
- The `injection` scenario has not been run against a live LLM.

---

## Repo layout

```
contract/      Rust smart contract (near-sdk 5.30.1)
  src/policy.rs    the policy engine — pure, no env, no state
  src/lib.rs       vault state, methods, audit log
integration/   sandbox tests (near-workspaces 0.24.0), kept separate so
               `cd contract && cargo test` needs no network
agent/         TypeScript agent runner (near-api-js 7.4.0) + scenarios
web/           Next.js dashboard (Next 16, React 19, Tailwind 4)
scripts/       setup-testnet.sh, reset-demo.sh
```

## Built with

near-sdk 5.30.1 · near-workspaces 0.24.0 · cargo-near 0.23.0 · near-cli-rs
0.31.1 · near-api-js 7.4.0 · @anthropic-ai/sdk 1.7.0 · Next.js 16.4.6 · React
19.3.1 · Tailwind 4.3.5 · @near-wallet-selector 10.1.4

Written from scratch during the NEAR HACKATHON window with AI coding assistance
(Claude Code). Licensed MIT — see [LICENSE](LICENSE).
