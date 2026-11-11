#!/usr/bin/env bash
#
# Create the whole Stipend demo on NEAR testnet from nothing:
#   accounts -> contract deploy -> funding -> the agent's restricted key -> policy seed
#
# Safe to re-run: every step checks whether it has already been done.
# Nothing here touches mainnet and nothing spends real money, but it does create
# public testnet accounts, so every command is printed before it runs.
#
#   ./scripts/setup-testnet.sh            # do it
#   ./scripts/setup-testnet.sh --dry-run  # print the commands only
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

RPC="${NEAR_RPC_URL:-https://test.rpc.fastnear.com}"
WASM="$REPO_ROOT/target/near/stipend_vault/stipend_vault.wasm"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '\033[36m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[32m✓\033[0m %s\n' "$*"; }
skip()  { printf '\033[2m·\033[0m %s\n' "$*"; }
die()   { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# Print every command, then run it unless this is a dry run.
# Arguments are quoted on the way out so the printed line can be pasted as-is.
run() {
  local shown=() a
  for a in "$@"; do
    if [[ "$a" =~ [[:space:]\"{}] ]]; then shown+=("'$a'"); else shown+=("$a"); fi
  done
  printf '\033[2m  $ %s\033[0m\n' "${shown[*]}"
  if [[ $DRY_RUN -eq 0 ]]; then "$@"; fi
}

account_exists() {
  local id="$1"
  local body
  body=$(curl -sS -m 20 -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$id\"}}" \
    2>/dev/null || true)
  [[ "$body" == *'"amount"'* ]]
}

contract_deployed() {
  local id="$1"
  local body
  body=$(curl -sS -m 20 -X POST "$RPC" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$id\"}}" \
    2>/dev/null || true)
  [[ "$body" == *'"code_hash":"11111111111111111111111111111111"'* ]] && return 1
  [[ "$body" == *'"code_hash"'* ]]
}

# ---------------------------------------------------------------------------
bold "Stipend testnet setup"
echo

# 0. Prerequisites
for cmd in near cargo node npm curl; do
  command -v "$cmd" >/dev/null 2>&1 || die "'$cmd' not found on PATH. See README prerequisites."
done
command -v cargo-near >/dev/null 2>&1 || die "'cargo-near' not found. Install: curl --proto '=https' --tlsv1.2 -LsSf https://github.com/near/cargo-near/releases/latest/download/cargo-near-installer.sh | sh"
ok "toolchain present"

# 1. Keys and account names
if [[ ! -f "$REPO_ROOT/.env" ]]; then
  info "generating keys and account names"
  run bash -c "cd '$REPO_ROOT/agent' && npm install --silent && npm run -s gen-keys ${STIPEND_ROOT:+-- $STIPEND_ROOT}"
else
  skip ".env already exists — reusing the accounts and keys in it"
fi
[[ $DRY_RUN -eq 1 && ! -f "$REPO_ROOT/.env" ]] && die "dry run needs an existing .env to show real account names; run 'cd agent && npm run gen-keys' first"

set -a; . "$REPO_ROOT/.env"; set +a
ok "root account: $STIPEND_ROOT"

# near-cli-rs 0.31 takes the signer's private key positionally and derives the
# public key from it.
SIGN_AS_OWNER=(network-config testnet sign-with-plaintext-private-key "$OWNER_PRIVATE_KEY" send)

# 2. Build the contract
if [[ ! -f "$WASM" ]]; then
  info "building the contract"
  run bash -c "cd '$REPO_ROOT/contract' && cargo near build non-reproducible-wasm"
else
  skip "wasm already built at target/near/stipend_vault/stipend_vault.wasm"
fi

# 3. Root account, sponsored by the testnet faucet
if account_exists "$STIPEND_ROOT"; then
  skip "root account $STIPEND_ROOT already exists"
else
  info "creating root account via the testnet faucet"
  run near account create-account sponsor-by-faucet-service "$STIPEND_ROOT" \
    use-manually-provided-public-key "$OWNER_PUBLIC_KEY" \
    network-config testnet create
fi

# 4. Sub-accounts
create_sub() {
  local id="$1" amount="$2" pubkey="$3" label="$4"
  if account_exists "$id"; then
    skip "$label $id already exists"
    return
  fi
  info "creating $label $id with $amount"
  run near account create-account fund-myself "$id" "$amount" \
    use-manually-provided-public-key "$pubkey" \
    sign-as "$STIPEND_ROOT" \
    "${SIGN_AS_OWNER[@]}"
}

# The testnet faucet sponsors the root account with ~10 NEAR, and everything
# below comes out of that, so these are deliberately tight. Top the vault up
# later with ./scripts/fund-vault.sh.
create_sub "$VAULT_CONTRACT_ID"   "7 NEAR"   "$VAULT_PUBLIC_KEY"    "vault"
create_sub "$AGENT_ACCOUNT_ID"    "0.6 NEAR" "$AGENT_PUBLIC_KEY"    "agent"
create_sub "$MERCHANT_ACCOUNT_ID" "0.1 NEAR" "$MERCHANT_PUBLIC_KEY" "merchant"
create_sub "$ATTACKER_ACCOUNT_ID" "0.1 NEAR" "$ATTACKER_PUBLIC_KEY" "attacker"
create_sub "$STRANGER_ACCOUNT_ID" "0.1 NEAR" "$STRANGER_PUBLIC_KEY" "unknown supplier"

# 5. Deploy and initialise
POLICY='{
  "max_per_tx":          "2000000000000000000000000",
  "daily_limit":         "5000000000000000000000000",
  "approval_threshold":  "1000000000000000000000000",
  "new_recipient_limit":  "500000000000000000000000",
  "allowlist_only":      false,
  "max_tx_per_hour":     10,
  "strike_limit":        3,
  "strike_window_ms":    3600000,
  "pending_ttl_ms":      86400000
}'
INIT_ARGS="{\"owner\":\"$OWNER_ACCOUNT_ID\",\"policy\":$(echo "$POLICY" | tr -d '\n ')}"

if contract_deployed "$VAULT_CONTRACT_ID"; then
  skip "contract already deployed to $VAULT_CONTRACT_ID"
else
  info "deploying the vault and calling new()"
  run near contract deploy "$VAULT_CONTRACT_ID" \
    use-file "$WASM" \
    with-init-call new json-args "$INIT_ARGS" \
    prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' \
    network-config testnet sign-with-plaintext-private-key "$VAULT_PRIVATE_KEY" send
fi

# 6. The vault was funded at creation. Anything more has to come from another
#    faucet-sponsored account, which is what fund-vault.sh does.

# 7. The whole point: give the agent a key that can ONLY call request_payment
info "adding the agent's function-call access key (request_payment only)"
run near account add-key "$AGENT_ACCOUNT_ID" \
  grant-function-call-access \
  --allowance '0.25 NEAR' \
  --contract-account-id "$VAULT_CONTRACT_ID" \
  --function-names 'request_payment' \
  use-manually-provided-public-key "$AGENT_FC_PUBLIC_KEY" \
  network-config testnet sign-with-plaintext-private-key "$AGENT_PRIVATE_KEY" send

# 8. Seed the policy: register the agent, allowlist the merchant, blocklist the attacker
owner_call() {
  local method="$1" args="$2"
  run near contract call-function as-transaction "$VAULT_CONTRACT_ID" "$method" \
    json-args "$args" \
    prepaid-gas '100.0 Tgas' attached-deposit '1 yoctoNEAR' \
    sign-as "$OWNER_ACCOUNT_ID" \
    "${SIGN_AS_OWNER[@]}"
}

info "registering the agent and seeding the lists"
owner_call add_agent        "{\"account_id\":\"$AGENT_ACCOUNT_ID\",\"label\":\"Shopping agent\"}"
owner_call add_to_allowlist "{\"account_id\":\"$MERCHANT_ACCOUNT_ID\"}"
owner_call add_to_blocklist "{\"account_id\":\"$ATTACKER_ACCOUNT_ID\"}"

# ---------------------------------------------------------------------------
echo
bold "Done."
echo
echo "  Vault      $VAULT_CONTRACT_ID"
echo "             https://testnet.nearblocks.io/address/$VAULT_CONTRACT_ID"
echo "  Owner      $OWNER_ACCOUNT_ID"
echo "  Agent      $AGENT_ACCOUNT_ID  (function-call key, request_payment only)"
echo "  Merchant   $MERCHANT_ACCOUNT_ID  (allowlisted)"
echo "  Attacker   $ATTACKER_ACCOUNT_ID  (blocklisted)"
echo
echo "  Next:  cd agent && npm run scenario -- compromised"
echo
