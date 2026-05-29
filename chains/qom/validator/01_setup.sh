#!/usr/bin/env bash
# Generate a fresh validator signing keypair and write VALIDATOR_KEY=
# into .env. Idempotent — refuses to overwrite an existing key.
#
# The same key is used across chains if you run multiple validators
# under one operator identity (recommended — simpler ISM management).
# Run this ONCE in your first chain's validator dir, then COPY the
# generated VALIDATOR_KEY into each subsequent chain's .env.

set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE=.env
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: no .env. Run: cp .env.example .env  and edit OPERATOR_NAME first."
  exit 2
fi

# shellcheck source=/dev/null
source "$ENV_FILE"

if [ -n "${VALIDATOR_KEY:-}" ] && [ "${VALIDATOR_KEY}" != "" ]; then
  echo "ERROR: VALIDATOR_KEY already set in .env — refusing to overwrite."
  echo "  To rotate: delete the VALIDATOR_KEY= line manually and re-run."
  exit 3
fi

# Pick a node runner: host or docker.
#
# NODE_PREFIX is the command run BEFORE `node ...`. Empty when host node is
# used; the docker invocation (which ends in the image name) when not. So
# subsequent invocations are `$NODE_PREFIX node ...`.
NODE_PREFIX=""
USE_HOST=0
if command -v node &>/dev/null; then
  if [ ! -d node_modules/ethers ]; then
    npm install ethers --no-save --silent >/dev/null 2>&1 || true
  fi
  if [ -d node_modules/ethers ]; then
    USE_HOST=1
  fi
fi
if [ "$USE_HOST" != "1" ]; then
  if ! command -v docker &>/dev/null; then
    echo "ERROR: need either host node + ethers, or docker."
    exit 4
  fi
  NODE_PREFIX="docker run --rm -v $PWD:/work -w /work --user $(id -u):$(id -g) node:20-bookworm-slim"
  if [ ! -d node_modules/ethers ]; then
    $NODE_PREFIX bash -c "npm install ethers --no-save --silent >/dev/null 2>&1"
  fi
fi

out=$($NODE_PREFIX node -e '
const { Wallet } = require("ethers");
const w = Wallet.createRandom();
console.log(w.privateKey + ":" + w.address);
')
privkey="${out%%:*}"
addr="${out##*:}"

# Replace empty VALIDATOR_KEY= line, or append if missing.
if grep -q '^VALIDATOR_KEY=' "$ENV_FILE"; then
  sed -i "s|^VALIDATOR_KEY=.*$|VALIDATOR_KEY=${privkey}|" "$ENV_FILE"
else
  echo "VALIDATOR_KEY=${privkey}" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"

cat > 02_announce.md <<EOF
# Validator key generated

Address: \`${addr}\`

**Share this address with the bridge admin** so they can add you to the
on-chain ISM. The admin will run:

  bash tools/promote_operator.sh add-validator ${addr}

This creates a new ISM via the factory containing your address and
swaps the bridge's warp routers to the new ISM. Once that lands you
can start the agent:

  ./drive.sh up -d

If you run validators for multiple chains, **copy this same
VALIDATOR_KEY into the .env of every other chain's validator dir** —
one key per operator across all chains keeps ISM management simple.
EOF

cat <<EOF

================================================================
  Validator key generated.

  Address: ${addr}

  Next step:
    cat 02_announce.md     # what to share with the bridge admin

  Then:
    ./drive.sh up -d
================================================================
EOF
