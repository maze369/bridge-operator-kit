#!/usr/bin/env bash
# Generate one EVM signer key per chain in RELAY_CHAINS (or every preset
# chain if RELAY_CHAINS is empty). Writes SIGNER_KEY_<CHAIN_UPPER>=...
# lines into .env. Idempotent — already-set keys are kept.
set -euo pipefail
cd "$(dirname "$0")"
KIT_ROOT="$(cd .. && pwd)"

ENV_FILE=.env
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: no .env. Run: cp .env.example .env  and edit it first."
  exit 2
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

# Default RELAY_CHAINS to every preset chain if empty.
if [ -z "${RELAY_CHAINS:-}" ]; then
  RELAY_CHAINS=$(ls "$KIT_ROOT/chains" 2>/dev/null | grep -v '^_' | grep -v '^\.' | paste -sd, -)
fi
if [ -z "${RELAY_CHAINS:-}" ]; then
  echo "ERROR: RELAY_CHAINS empty and no chain presets found in $KIT_ROOT/chains/"; exit 3
fi
echo "Relaying to chains: $RELAY_CHAINS"

# We need ethers for keypair generation. Try host node first; fall back
# to a one-shot container if the host doesn't have it.
#
# NODE_PREFIX is the command run BEFORE `node ...`. Empty when host node is
# used; the docker invocation (which ends in the image name) when not.
# Subsequent invocations look like `$NODE_PREFIX node -e ...`.
NODE_PREFIX=""
if command -v node &>/dev/null && [ -d "node_modules/ethers" ]; then
  NODE_PREFIX=""
elif command -v docker &>/dev/null; then
  NODE_PREFIX="docker run --rm -v $PWD:/work -w /work --user $(id -u):$(id -g) node:20-bookworm-slim"
  # Install ethers into the project's node_modules so subsequent runs are fast.
  if [ ! -d node_modules/ethers ]; then
    echo "Installing ethers..."
    $NODE_PREFIX bash -c "npm install ethers --no-save --silent >/dev/null 2>&1"
  fi
else
  echo "ERROR: need either host node + node_modules/ethers, or docker."
  exit 4
fi

IFS=',' read -ra CHAINS <<< "$RELAY_CHAINS"

# Initialize as empty arrays. Plain `declare -a NAME` leaves the variable
# "unset" enough that ${#NAME[@]} trips `set -u` on some bash versions.
NEW_LINES=()
ROWS=()

# Helper: extract a chain.yaml's flat gasPrice override (if any) and the
# chain's native symbol. Surfaces them in 02_fund_keys.md so operators
# notice that flat-fee chains (e.g. with gasPrice=18e18) need orders of
# magnitude more native than EIP-1559 chains for the same number of
# deliveries.
chain_gas_note() {
  local c="$1"
  local yamlf="$KIT_ROOT/chains/$c/chain.yaml"
  [ -f "$yamlf" ] || { echo "—"; return; }
  local gp
  gp=$(awk '/^transactionOverrides:/{f=1; next} f && /gasPrice:/{gsub(/[ "\047]/,""); split($0,a,":"); print a[2]; exit}' "$yamlf")
  if [ -n "$gp" ]; then
    echo "flat $gp wei / gas"
  else
    echo "EIP-1559 (dynamic)"
  fi
}

chain_native_symbol() {
  local c="$1"
  local yamlf="$KIT_ROOT/chains/$c/chain.yaml"
  [ -f "$yamlf" ] || { echo "?"; return; }
  awk '/^native:/{f=1; next} f && /symbol:/{gsub(/[ "\047]/,""); split($0,a,":"); print a[2]; exit}' "$yamlf"
}

for raw in "${CHAINS[@]}"; do
  c="$(echo "$raw" | xargs)"
  varname="SIGNER_KEY_$(echo "$c" | tr '[:lower:]-' '[:upper:]_')"
  sym=$(chain_native_symbol "$c")
  gas=$(chain_gas_note "$c")

  existing="${!varname:-}"
  if [ -n "$existing" ]; then
    addr=$($NODE_PREFIX node -e "console.log(new (require('ethers').Wallet)('$existing').address)")
    echo "  [${c}] already has signer ${addr} — keep"
    ROWS+=("| ${c} | ${sym:-?} | ${gas} | \`${addr}\` |")
    continue
  fi

  out=$($NODE_PREFIX node -e '
const { Wallet } = require("ethers");
const w = Wallet.createRandom();
console.log(w.privateKey + ":" + w.address);
')
  privkey="${out%%:*}"
  addr="${out##*:}"
  NEW_LINES+=("${varname}=${privkey}")
  ROWS+=("| ${c} | ${sym:-?} | ${gas} | \`${addr}\` |")
  echo "  [${c}] generated new signer ${addr}"
done

if [ ${#NEW_LINES[@]} -gt 0 ]; then
  {
    echo ""
    echo "# === Per-chain signer keys (generated $(date -u +%FT%TZ)) ==="
    printf "%s\n" "${NEW_LINES[@]}"
  } >> "$ENV_FILE"
fi

chmod 600 "$ENV_FILE"

cat > 02_fund_keys.md <<EOF
# Fund these signer keys before starting the relayer

Each address below needs a balance of the native gas token on its
chain. The relayer agent refuses to start delivering to a chain whose
signer balance is 0; it warns (and you should refill) when below 50%
of recommended.

| Chain | Native | Gas pricing | Signer address |
|-------|--------|-------------|----------------|
$(printf "%s\n" "${ROWS[@]}")

## How to size each top-up

The right balance depends on the chain's gas model:

- **EIP-1559 chains** (\`dynamic\` row above) — gas price floats with
  network congestion; typical delivery costs a small fraction of a
  native token. Budget ~1,000 deliveries' worth.
- **Flat-fee chains** (\`flat N wei / gas\` row above) — every tx pays
  exactly \`gasPrice × gas_used\`, no auction. One delivery of a
  Hyperlane \`process()\` is ~200k gas. So a flat \`gasPrice = 18e18 wei\`
  means **~3.6 million native per single delivery**; the same 1,000
  deliveries cost ~3.6 billion native. Size accordingly.

Send from your own wallet, or ping the operator channel for a top-up.

After funding, start the agent: \`./drive.sh up -d\`
EOF

cat <<EOF

================================================================
  All signer keys ready.

  Next step:
    cat 02_fund_keys.md    # see addresses + amounts to fund

  Then:
    ./drive.sh up -d
================================================================
EOF
