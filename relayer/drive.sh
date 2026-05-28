#!/bin/bash
# drive.sh — docker compose wrapper for the bridge-relayer service.
# Mirrors the Drive convention (services/*/drive.sh) so the operator
# UX matches other Drive services. Auto-detects compose flavor,
# handles PUID/PGID, and tails logs after `up -d`.
#
# Usage:
#   ./drive.sh up -d        # start; auto-tails logs
#   ./drive.sh down         # stop
#   ./drive.sh logs -f      # follow logs
#   ./drive.sh ps           # container status
#   ./drive.sh restart      # full restart
#   ./drive.sh exec <cmd>   # exec inside the container
#   ./drive.sh status       # custom: signing lag + bucket reach

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
KIT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Rebuild the consolidated agent-config from every chains/*/chain.yaml
# AND the per-chain signer/RPC env from relayer/.env. drive.sh runs
# both on every `up` so adding a chain is just: drop a chain.yaml,
# add SIGNER_KEY_<KEY> to .env, drive.sh restart.
NODE_CMD=""
if command -v node &>/dev/null; then
    NODE_CMD="node"
else
    NODE_CMD="docker run --rm -v $KIT_ROOT:/work -w /work node:20-bookworm-slim node"
fi
if [ -f "$KIT_ROOT/tools/build_agent_config.mjs" ]; then
    $NODE_CMD "$KIT_ROOT/tools/build_agent_config.mjs"
fi
if [ -f "$KIT_ROOT/tools/build_relayer_env.mjs" ]; then
    $NODE_CMD "$KIT_ROOT/tools/build_relayer_env.mjs"
fi

# Detect compose flavor
if command -v docker-compose &>/dev/null; then
    DCC="docker-compose"
elif docker compose version &>/dev/null 2>&1; then
    DCC="docker compose"
else
    echo "❌ docker-compose / 'docker compose' not found"
    exit 1
fi

# Verify compose file
if [ ! -f "docker-compose.yml" ]; then
    echo "❌ docker-compose.yml not found in $SCRIPT_DIR"
    exit 1
fi

# Verify .env exists (operator should have copied from .env.example)
if [ ! -f ".env" ] && [ "${1:-}" != "help" ]; then
    echo "⚠️  No .env file found. Copy from template:"
    echo "    cp .env.example .env"
    echo "    # edit .env with your values, then re-run."
    exit 1
fi

# Translate CHAINS_TO_WATCH (validator) or RELAY_CHAINS (relayer) into
# Compose profiles, so only enabled chain services start.
if [ -f ".env" ]; then
    # shellcheck disable=SC1091
    set -a; . ./.env; set +a
fi
PROFILES="${CHAINS_TO_WATCH:-${RELAY_CHAINS:-}}"
if [ -n "$PROFILES" ]; then
    export COMPOSE_PROFILES="$PROFILES"
fi

# Use OPERATOR_NAME as the compose project so multiple operators on the
# same host don't collide on volume / network names.
if [ -n "${OPERATOR_NAME:-}" ]; then
    export COMPOSE_PROJECT_NAME="${OPERATOR_NAME}-relayer"
fi

# Permissions: container runs as UID 1000. If sudo'd, fix any bind-mount
# ownership; otherwise just chmod world-writable so the container can write.
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

# Custom subcommand: ./drive.sh status — wraps the role's status.sh
if [ "${1:-}" = "status" ]; then
    if [ -x "./status.sh" ]; then
        exec ./status.sh "${@:2}"
    else
        echo "❌ status.sh not found or not executable"
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

# After `up -d`: brief wait, then tail logs — but ONLY if stdin is a tty.
# Non-tty contexts (ssh without -t, CI, pipelines) would hang. Operators
# wanting logs from a non-tty context use `./drive.sh logs -f`.
if [ "$SHOW_LOGS" = true ] && [ $EXIT -eq 0 ] && [ -t 0 ] && [ "${DRIVE_NO_TAIL:-}" != "1" ]; then
    echo
    echo "📋 Started in detached mode. Tailing logs (Ctrl+C to detach — container keeps running)…"
    echo
    cleanup_logs() {
        echo
        echo "ℹ️  Detached from logs. Container continues running."
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
