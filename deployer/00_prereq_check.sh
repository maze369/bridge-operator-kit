#!/usr/bin/env bash
# Pre-deploy sanity check. Run BEFORE any deploy_*.mjs script.
set -euo pipefail
cd "$(dirname "$0")"

errors=0
warn() { echo "  WARN: $1"; }
fail() { echo "  FAIL: $1"; errors=$((errors+1)); }
ok()   { echo "  OK:   $1"; }

echo "=== Pre-deploy environment check ==="

# Tools
for cmd in node docker git curl python3; do
  if command -v "$cmd" >/dev/null; then ok "$cmd installed";
  else fail "$cmd missing"; fi
done

# Node version >= 20
node_major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
if [ "$node_major" -ge 20 ]; then ok "Node $node_major"; else fail "Node 20+ required (got $node_major)"; fi

# Python yaml module
if python3 -c 'import yaml' 2>/dev/null; then
  ok "python3-yaml available"
else
  warn "python3 yaml module missing — RPC reachability check will be skipped"
fi

# Shared config exists
if [ -f ../shared/addresses.yaml ]; then ok "shared/addresses.yaml present";
else fail "shared/addresses.yaml missing — copy from addresses.example.yaml and fill in"; fi
if [ -f ../shared/agent-config.json ]; then ok "shared/agent-config.json present";
else fail "shared/agent-config.json missing"; fi

# Deployer key present
if [ -n "${DEPLOYER_KEY:-}" ]; then
  ok "DEPLOYER_KEY present (won't echo)"
elif [ -n "${DEPLOYER_KEY_FILE:-}" ] && [ -f "${DEPLOYER_KEY_FILE}" ]; then
  ok "DEPLOYER_KEY_FILE present at $DEPLOYER_KEY_FILE"
else
  fail "DEPLOYER_KEY (or DEPLOYER_KEY_FILE) not set — export it before running _run_deploy.sh"
fi

# RPCs reachable (from addresses.yaml). Skip silently if python3-yaml missing.
if [ -f ../shared/addresses.yaml ] && python3 -c 'import yaml' 2>/dev/null; then
  while IFS=$'\t' read -r chain rpc; do
    [ -z "$chain" ] && continue
    [ -z "$rpc" ] && { warn "RPC empty for chain: $chain (operator override expected)"; continue; }
    case "$rpc" in
      \$\{*) warn "RPC placeholder for $chain: $rpc (operator override expected)"; continue ;;
    esac
    if curl -sf -X POST "$rpc" -H 'Content-Type: application/json' \
        -d '{"jsonrpc":"2.0","method":"eth_chainId","params":[],"id":1}' \
        --max-time 10 >/dev/null; then
      ok "RPC reachable: $chain"
    else
      fail "RPC unreachable: $chain ($rpc)"
    fi
  done < <(python3 - <<'PY'
import yaml, sys
with open('../shared/addresses.yaml') as f:
    y = yaml.safe_load(f)
for k, ch in (y.get('chains') or {}).items():
    rpc = (ch.get('rpcUrls') or [None])[0] or ''
    print(f"{k}\t{rpc}")
PY
)
fi

echo
if [ "$errors" -gt 0 ]; then
  echo "$errors check(s) failed. Fix before proceeding."
  exit 1
fi
echo "Pre-deploy checks all green. Continue with deploy_evm_core.mjs (or the appropriate runbook in ../runbooks/)."
