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
NODE_RUN=""
if command -v node &>/dev/null && [ -d "node_modules/ethers" ]; then
  NODE_RUN="node"
elif command -v docker &>/dev/null; then
  NODE_RUN="docker run --rm -v $PWD:/work -w /work node:20-bookworm-slim"
  # Install ethers into the project's node_modules so subsequent runs are fast.
  if [ ! -d node_modules/ethers ]; then
    echo "Installing ethers..."
    $NODE_RUN bash -c "npm install ethers --no-save --silent >/dev/null 2>&1"
  fi
else
  echo "ERROR: need either host node + node_modules/ethers, or docker."
  exit 4
fi

IFS=',' read -ra CHAINS <<< "$RELAY_CHAINS"

declare -a NEW_LINES
declare -a ROWS

for raw in "${CHAINS[@]}"; do
  c="$(echo "$raw" | xargs)"
  varname="SIGNER_KEY_$(echo "$c" | tr '[:lower:]-' '[:upper:]_')"

  existing="${!varname:-}"
  if [ -n "$existing" ]; then
    addr=$($NODE_RUN node -e "console.log(new (require('ethers').Wallet)('$existing').address)")
    echo "  [${c}] already has signer ${addr} — keep"
    ROWS+=("| ${c} | \`${addr}\` |")
    continue
  fi

  out=$($NODE_RUN node -e '
const { Wallet } = require("ethers");
const w = Wallet.createRandom();
console.log(w.privateKey + ":" + w.address);
')
  privkey="${out%%:*}"
  addr="${out##*:}"
  NEW_LINES+=("${varname}=${privkey}")
  ROWS+=("| ${c} | \`${addr}\` |")
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

Each address below needs a small balance of the native gas token on
its chain. The relayer agent will refuse to start delivering to a
chain if its signer balance is 0; warns (and you should refill) when
below 50% of recommended.

Recommended balance per chain: enough for ~1,000 deliveries.

| Chain | Signer address |
|-------|----------------|
$(printf "%s\n" "${ROWS[@]}")

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
