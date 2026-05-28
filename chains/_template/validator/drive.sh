#!/bin/bash
# drive.sh — docker compose wrapper for the per-chain validator.
#
# This file is identical across every chain preset. It reads
# ../chain.yaml to determine which chain it's serving and exports
# the right env vars for the generic docker-compose.yml.
#
# Usage:
#   ./drive.sh up -d        # start; auto-tails logs
#   ./drive.sh down         # stop
#   ./drive.sh logs -f      # follow logs
#   ./drive.sh ps           # container status
#   ./drive.sh restart      # full restart
#   ./drive.sh status       # signing lag + bucket reach
#   ./drive.sh exec <cmd>   # exec inside the container

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Find the kit root (chains/<key>/validator → ../../..).
KIT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CHAIN_YAML="$SCRIPT_DIR/../chain.yaml"

if [ ! -f "$CHAIN_YAML" ]; then
    echo "ERROR: ../chain.yaml not found. Are you running this from a chains/<key>/validator/ dir?"
    exit 1
fi

# Detect compose flavor
if command -v docker-compose &>/dev/null; then
    DCC="docker-compose"
elif docker compose version &>/dev/null 2>&1; then
    DCC="docker compose"
else
    echo "ERROR: docker-compose / 'docker compose' not found"
    exit 1
fi

if [ ! -f "docker-compose.yml" ]; then
    echo "ERROR: docker-compose.yml not found in $SCRIPT_DIR"
    exit 1
fi

if [ ! -f ".env" ] && [ "${1:-}" != "help" ]; then
    echo "No .env file found. Copy from template:"
    echo "    cp .env.example .env"
    echo "    # edit .env with your operator name, key, bucket"
    exit 1
fi

# Pull chain key from chain.yaml's top-level `key:` field.
CHAIN_KEY=$(awk -F: '/^key:[[:space:]]*/{gsub(/[[:space:]"'\'']/,"",$2); print $2; exit}' "$CHAIN_YAML")
if [ -z "$CHAIN_KEY" ]; then
    echo "ERROR: could not extract `key:` from $CHAIN_YAML"
    exit 1
fi
CHAIN_KEY_UPPER=$(echo "$CHAIN_KEY" | tr '[:lower:]-' '[:upper:]_')
export CHAIN_KEY CHAIN_KEY_UPPER

# Reorg period from chain.yaml (validator agent reads this).
CHAIN_REORG_PERIOD=$(awk '/^[[:space:]]*reorgPeriod:[[:space:]]*/{gsub(/[[:space:]"'\'',]/,"",$2); print $2; exit}' "$CHAIN_YAML" 2>/dev/null || echo 5)
export CHAIN_REORG_PERIOD="${CHAIN_REORG_PERIOD:-5}"

# Per-host RPC override: if the operator set <CHAIN_KEY>_RPC in .env,
# forward it to the agent. drive.sh evaluates this lazily so the .env
# variable name can match the chain key (underscores).
if [ -f ".env" ]; then
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
fi
RPC_VAR="${CHAIN_KEY_UPPER}_RPC"
export CHAIN_RPC_OVERRIDE="${!RPC_VAR:-}"

# COMPOSE_PROJECT_NAME = <chain>-validator-<operator>  →  unique per
# (chain, operator) so multiple chains' validators don't collide on
# volume / network names.
export COMPOSE_PROJECT_NAME="${CHAIN_KEY}-validator-${OPERATOR_NAME:-default}"

# Rebuild the consolidated agent-config from every chains/*/chain.yaml
# before bringing the agent up. Idempotent — same input == same output.
if [ -x "$KIT_ROOT/tools/build_agent_config.sh" ]; then
    "$KIT_ROOT/tools/build_agent_config.sh"
elif [ -f "$KIT_ROOT/tools/build_agent_config.mjs" ]; then
    if command -v node &>/dev/null; then
        node "$KIT_ROOT/tools/build_agent_config.mjs"
    else
        # No host node? Run inside a one-shot container.
        docker run --rm \
          -v "$KIT_ROOT":/work -w /work \
          node:20-bookworm-slim node tools/build_agent_config.mjs
    fi
fi

# Permissions: container runs as UID 1000.
export PUID=${SUDO_UID:-$(id -u)}
export PGID=${SUDO_GID:-$(id -g)}
for d in data state checkpoints; do
    if [ -d "$d" ]; then
        chmod -R 775 "$d" 2>/dev/null || chmod -R 777 "$d" 2>/dev/null || true
        if [ -n "${SUDO_USER:-}" ]; then
            chown -R 1000:1000 "$d" 2>/dev/null || true
        fi
    fi
done

# Custom subcommand: status (wraps status.sh)
if [ "${1:-}" = "status" ]; then
    if [ -x "./status.sh" ]; then
        exec ./status.sh "${@:2}"
    else
        echo "ERROR: status.sh not found or not executable"
        exit 1
    fi
fi

# Detect `up -d` so we can auto-tail logs after start
SHOW_LOGS=false
if [ "${1:-}" = "up" ]; then
    for arg in "$@"; do
        case "$arg" in -d|--detach) SHOW_LOGS=true;; esac
    done
fi

# Run the compose command (preserve sudo env if invoked via sudo)
EXIT=0
if [ -n "${SUDO_USER:-}" ]; then
    sudo -E $DCC "$@" || EXIT=$?
else
    $DCC "$@" || EXIT=$?
fi

# After `up -d`: brief wait, then tail logs — only if stdin is a tty.
if [ "$SHOW_LOGS" = true ] && [ $EXIT -eq 0 ] && [ -t 0 ] && [ "${DRIVE_NO_TAIL:-}" != "1" ]; then
    echo
    echo "Started in detached mode. Tailing logs (Ctrl+C to detach — container keeps running)..."
    echo
    cleanup_logs() {
        echo
        echo "Detached from logs. Container continues running."
        echo "   View again: ./drive.sh logs -f"
        exit 0
    }
    trap cleanup_logs INT TERM
    sleep 2
    if [ -n "${SUDO_USER:-}" ]; then
        sudo -E $DCC logs -f --tail=0 || cleanup_logs
    else
        $DCC logs -f --tail=0 || cleanup_logs
    fi
elif [ "$SHOW_LOGS" = true ] && [ $EXIT -eq 0 ]; then
    echo
    echo "Started in detached mode. (Skipping log tail — non-interactive shell.)"
    echo "View logs: ./drive.sh logs -f"
fi

exit $EXIT
