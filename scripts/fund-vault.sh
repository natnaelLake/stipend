#!/usr/bin/env bash
#
# Top the vault up.
#
# The testnet faucet funds one account at a time, and the vault's own storage
# reserve already holds ~2.6 NEAR for the contract code, so a single faucet
# grant does not leave much spendable. This creates a throwaway faucet-funded
# account and deletes it with the vault as beneficiary, which moves the whole
# balance across in one transaction.
#
# Usage: ./scripts/fund-vault.sh [--dry-run]
set -euo pipefail

cd "$(dirname "$0")/.."
[ -f .env ] || { echo "no .env — run ./scripts/setup-testnet.sh first" >&2; exit 1; }
set -a; . ./.env; set +a

: "${VAULT_CONTRACT_ID:?set in .env}"
: "${OWNER_PUBLIC_KEY:?set in .env}"
: "${OWNER_PRIVATE_KEY:?set in .env}"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

TEMP="stipend-fund-$(openssl rand -hex 3).testnet"

info() { printf '\n\033[1m%s\033[0m\n' "$*"; }
run() {
  printf '\033[2m  $ %s\033[0m\n' "$*"
  [ "$DRY" = "1" ] && return 0
  "$@"
}

info "creating a throwaway faucet-funded account: $TEMP"
run near account create-account sponsor-by-faucet-service "$TEMP" \
  use-manually-provided-public-key "$OWNER_PUBLIC_KEY" \
  network-config testnet create

info "moving its whole balance into $VAULT_CONTRACT_ID"
# Deleting with a beneficiary transfers the remaining balance; no separate
# transfer is needed and nothing is left stranded in the throwaway account.
run near account delete-account "$TEMP" \
  beneficiary "$VAULT_CONTRACT_ID" \
  network-config testnet \
  sign-with-plaintext-private-key "$OWNER_PRIVATE_KEY" send

info "done"
if [ "$DRY" = "0" ]; then
  near contract call-function as-read-only "$VAULT_CONTRACT_ID" get_balance \
    json-args '{}' network-config testnet now 2>/dev/null | head -20 || true
fi
