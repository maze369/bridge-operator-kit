#!/usr/bin/env bash
# Runs a deploy_*.mjs script inside a node:20 container with the right
# ethers + @hyperlane-xyz/core versions installed at runtime.
#
# Env:
#   DEPLOYER_KEY        — 0x-prefixed hex PK (required, unless DEPLOYER_KEY_FILE set).
#   DEPLOYER_KEY_FILE   — path to a file whose first 0x...64hex match is the PK (alt to DEPLOYER_KEY).
#   KIT_ROOT            — absolute path to operator-kit checkout (default: parent of deployer/).
#   DOCKER_NETWORK      — docker network to attach the runner to (default: bridge).
#
# The script is mounted into the container at /work. Artifacts written under
# /work/deployer/ land on the host's KIT_ROOT/deployer/.
set -euo pipefail
SCRIPT=${1:?"usage: _run_deploy.sh <script.mjs> [extra docker args...]"}
shift

KIT_ROOT=${KIT_ROOT:-"$(cd "$(dirname "$0")/.." && pwd)"}

if [ -n "${DEPLOYER_KEY:-}" ]; then
  PK="$DEPLOYER_KEY"
elif [ -n "${DEPLOYER_KEY_FILE:-}" ]; then
  [ -f "$DEPLOYER_KEY_FILE" ] || { echo "FATAL: DEPLOYER_KEY_FILE=$DEPLOYER_KEY_FILE not found"; exit 1; }
  PK=$(grep -oE '0x[0-9a-fA-F]{64}' "$DEPLOYER_KEY_FILE" | head -1)
else
  echo "FATAL: set DEPLOYER_KEY=0x... (or DEPLOYER_KEY_FILE=/path/to/key.txt)"; exit 1
fi
[ -n "$PK" ] || { echo "FATAL: no 0x...64hex PK found"; exit 1; }
echo "[runner] running $SCRIPT — pk len ${#PK}, kit root $KIT_ROOT"

# Per-chain owner overrides: any HYP_KEY_<CHAIN> env (or
# DEPLOYER_KEY_<CHAIN>_FILE pointing at a key file) gets forwarded to
# update_ism.mjs so multi-owner bridges can swap routers on each chain
# with the correct key. <CHAIN> matches the chain key in addresses.yaml
# uppercased, with dashes → underscores.
# Example: DEPLOYER_KEY_CHAIN_B_FILE=/path/to/chain-b-deploy.key
PER_CHAIN_FLAGS=()
for ev in $(env | grep -oE '^DEPLOYER_KEY_[A-Z0-9]+_FILE=' | sed 's/=$//'); do
  chain="${ev#DEPLOYER_KEY_}"
  chain="${chain%_FILE}"
  keyfile="${!ev}"
  [ -f "$keyfile" ] || { echo "FATAL: $ev=$keyfile not found"; exit 1; }
  ck=$(grep -oE '0x[0-9a-fA-F]{64}' "$keyfile" | head -1)
  [ -n "$ck" ] || { echo "FATAL: $ev contained no PK"; exit 1; }
  PER_CHAIN_FLAGS+=( -e "HYP_KEY_${chain}=${ck}" )
  echo "[runner]   per-chain key for ${chain} (pk len ${#ck})"
done
for ev in $(env | grep -oE '^DEPLOYER_KEY_[A-Z0-9]+=' | sed 's/=$//'); do
  chain="${ev#DEPLOYER_KEY_}"
  case "$chain" in
    FILE|*_FILE) continue ;;  # bare FILE = DEPLOYER_KEY_FILE; *_FILE = handled above
  esac
  ck="${!ev}"
  PER_CHAIN_FLAGS+=( -e "HYP_KEY_${chain}=${ck}" )
  echo "[runner]   per-chain key for ${chain} (pk len ${#ck})"
done

# Pass through any HYP_* env vars (HYP_RPC, HYP_VALIDATOR, VALIDATORS,
# THRESHOLD, SKIP_ROUTER_SWAP, etc) — these are the standard interface
# every deploy_*.mjs script reads. Also passes through any caller-set
# overrides without us having to hard-list them.
HYP_PASSTHROUGH=()
for ev in $(env | grep -oE '^(HYP_[A-Z0-9_]+|VALIDATORS|THRESHOLD|SKIP_ROUTER_SWAP|CHAIN_FILTER|ENROLLMENTS)=' | sed 's/=$//'); do
  [ "$ev" = "HYP_KEY" ] && continue   # already set above
  HYP_PASSTHROUGH+=( -e "${ev}=${!ev}" )
done

DOCKER_NETWORK=${DOCKER_NETWORK:-bridge}

docker run --rm --network "$DOCKER_NETWORK" \
  -v "$KIT_ROOT":/work \
  -e HYP_KEY="$PK" \
  "${PER_CHAIN_FLAGS[@]}" \
  "${HYP_PASSTHROUGH[@]}" \
  "$@" \
  node:20-bookworm-slim bash -c "
    cd /work
    # Force ethers@5 + core@3.1.10 — the deploy scripts use v5 syntax
    # (providers namespace, ContractFactory.deploy returns deployTransaction).
    # Install is npm-cached so this is fast on re-runs.
    npm i @hyperlane-xyz/core@3.1.10 ethers@5 --no-save --silent >/dev/null 2>&1
    node /work/deployer/$(basename "$SCRIPT")
  " 2>&1 | grep -viE 'duplicate proto|already registered'
