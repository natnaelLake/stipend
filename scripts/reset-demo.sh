#!/usr/bin/env bash
#
# Put the demo back into a recordable state between takes:
#   unpause the vault, unfreeze the agent, clear the approval queue.
#
# The audit log is deliberately NOT cleared — it is append-only on purpose, and
# a log full of blocked attacks is the thing worth showing.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

[[ -f .env ]] || { echo "No .env — run ./scripts/setup-testnet.sh first" >&2; exit 1; }
set -a; . ./.env; set +a

RPC="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"

run() { printf '\033[2m  $ %s\033[0m\n' "$*"; "$@"; }

owner_call() {
  run near contract call-function as-transaction "$VAULT_CONTRACT_ID" "$1" \
    json-args "$2" \
    prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' \
    sign-as "$OWNER_ACCOUNT_ID" \
    network-config testnet sign-with-plaintext-private-key \
    --signer-public-key "$OWNER_PUBLIC_KEY" --signer-private-key "$OWNER_PRIVATE_KEY" send
}

view() {
  curl -sS -m 20 -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$VAULT_CONTRACT_ID\",\"method_name\":\"$1\",\"args_base64\":\"$(printf '%s' "$2" | base64)\"}}"
}

echo "Resetting the Warden demo on $VAULT_CONTRACT_ID"
echo

echo "→ unpausing the vault"
owner_call unpause '{}' || true

echo "→ unfreezing $AGENT_ACCOUNT_ID (also resets its strikes)"
owner_call unfreeze_agent "{\"account_id\":\"$AGENT_ACCOUNT_ID\"}" || true

echo "→ clearing the approval queue"
PENDING_IDS=$(view get_pending '{}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).result;if(!r||!r.result){console.log("");return;}const v=JSON.parse(Buffer.from(r.result).toString());console.log(v.map(p=>p.id).join(" "));})')

if [[ -z "${PENDING_IDS// }" ]]; then
  echo "  (queue already empty)"
else
  for id in $PENDING_IDS; do
    echo "  rejecting pending #$id"
    owner_call reject_pending "{\"id\":\"$id\"}" || true
  done
fi

echo
echo "Ready. The audit log is intentionally preserved."
