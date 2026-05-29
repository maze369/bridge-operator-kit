#!/usr/bin/env bash
# Read-only status: signer balances, container health, recent delivery rate.
set -euo pipefail
cd "$(dirname "$0")"

# shellcheck source=/dev/null
# Use auto-export so .env vars propagate into child node processes.
set -a; source .env; set +a

echo "=== Relayer status @ $(date -u +%FT%TZ) ==="
echo "Operator: ${OPERATOR_NAME:-(unset)}"
echo "Chains:   ${RELAY_CHAINS:-(unset)}"
echo "Stagger:  ${RELAYER_DELAY_MS} ms"
echo

# Container health
echo "--- Containers ---"
docker compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.RunningFor}}' 2>/dev/null || echo "(no containers)"
echo

# Per-chain signer balance
echo "--- Signer balances ---"
IFS=',' read -ra CHAINS <<< "$RELAY_CHAINS"
for raw in "${CHAINS[@]}"; do
  c="$(echo "$raw" | xargs)"
  varname="SIGNER_KEY_$(echo "$c" | tr '[:lower:]-' '[:upper:]_')"
  pk="${!varname:-}"
  [ -z "$pk" ] && { echo "  [${c}] (no key)"; continue; }

  node <<JS
const { Wallet, JsonRpcProvider, formatEther } = require("ethers");
const yaml = require("yaml");
const fs = require("fs");
(async () => {
  try {
    // Expand \${VAR} placeholders against the env (e.g. <CHAIN_KEY_UPPER>_RPC overrides).
    const raw = fs.readFileSync("../shared/addresses.yaml", "utf8");
    const expanded = raw.replace(/\\\$\{([A-Z0-9_]+)\}/g,
      (_, n) => process.env[n] || "__MISSING_" + n + "__");
    const addrs = yaml.parse(expanded);
    const ch = addrs.chains["${c}"];
    if (!ch) { console.log("  [${c}] not in addresses.yaml"); return; }
    const rpc = ch.rpcUrls && ch.rpcUrls[0];
    if (!rpc || String(rpc).startsWith("__MISSING_")) {
      const v = String(rpc || "").replace("__MISSING_", "").replace(/__$/, "");
      console.log(\`  [${c}] no RPC — set \${v || "the chain's RPC env var"} in .env\`);
      return;
    }
    const p = new JsonRpcProvider(rpc);
    const w = new Wallet("${pk}");
    const bal = await p.getBalance(w.address);
    const human = formatEther(bal);
    const warn = parseFloat(human) < 0.01 ? "  ⚠ LOW" : "";
    console.log(\`  [${c}] \${w.address}: \${human} native\${warn}\`);
  } catch (e) { console.log("  [${c}] err: " + (e.shortMessage || e.message)); }
})();
JS
done
echo

# Recent agent log digest
echo "--- Last 30 relayer log lines ---"
docker compose logs --tail 30 hyperlane-relayer 2>&1 | tail -30 || true
