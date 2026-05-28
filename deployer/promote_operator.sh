#!/usr/bin/env bash
# promote_operator.sh — phase-aware one-command admin action.
#
# Wraps the multi-step add-validator / add-relayer flow into a single
# command so the core team can onboard approved operators with one
# invocation. Works identically in Phase 1 (EOA admin), Phase 2 (Gnosis
# Safe), and Phase 3 (DAO Governor + Timelock); the on-chain payload is
# the same, only the authorization vehicle differs. The script
# auto-detects which phase the bridge is in by reading router.owner()
# and dispatches to the right emit-or-broadcast path.
#
# Usage:
#   bash promote_operator.sh add-validator <addr> [--mode broadcast|safe-tx|proposal]
#       Adds <addr> to ismValidators on every chain, then either:
#         - broadcast: signs + sends factory.deploy + setIsm txs (Phase 1)
#         - safe-tx:   emits Gnosis Safe Transaction-Builder JSON per router (Phase 2)
#         - proposal:  emits OZ Governor proposal payload (Phase 3)
#       After on-chain (or after artifact emit), updates shared/addresses.yaml
#       with the new ISM addresses, regenerates state.json, and (if
#       BRIDGE_HOST is set) pushes state.json to the bridge UI host via
#       scp + docker cp — no rebuild needed because the kit's reference
#       deploy bind-mounts state.json into the container.
#
#   bash promote_operator.sh remove-validator <addr> [--mode ...]
#       Symmetric removal. New ISM has the operator dropped; routers swap.
#
#   bash promote_operator.sh add-relayer <name> <role> <delay_ms> <chain1=0x...,chain2=0x...>
#       Appends to top-level relayers: block. NO on-chain action (relayer
#       set is off-chain — admin curation only). state.json regen + push.
#
#   bash promote_operator.sh remove-relayer <name>
#       Removes by name. NO on-chain action.
#
#   bash promote_operator.sh sync-state
#       Just regenerates state.json from current addresses.yaml + pushes.
#       Useful after manual yaml edits.
#
# Env (inherited by _run_deploy.sh when broadcasting):
#   DEPLOYER_KEY / DEPLOYER_KEY_FILE — Phase 1 admin PK
#   KIT_ROOT — defaults to parent of deployer/
#   DOCKER_NETWORK — defaults to "bridge"
#   THRESHOLD — explicit threshold for the new ISM (default: 1; raise as the
#               validator set grows)
#
# Bridge UI push (optional — only needed if you serve a state.json-driven UI):
#   BRIDGE_HOST          — ssh target where the bridge UI lives. UNSET = skip the push.
#   BRIDGE_REMOTE_DIR    — remote dir holding state.json (default: ~/bridge-ui)
#   BRIDGE_CONTAINER     — bridge UI container to docker-cp into.
#                          UNSET = scp the file but skip the docker cp step.

set -euo pipefail

CMD="${1:?usage: bash promote_operator.sh <add-validator|remove-validator|add-relayer|remove-relayer|sync-state> ...}"
shift

_SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
KIT_ROOT="${KIT_ROOT:-$(cd "$_SCRIPT_DIR/.." && pwd)}"
export KIT_ROOT
BRIDGE_HOST="${BRIDGE_HOST:-}"
BRIDGE_REMOTE_DIR="${BRIDGE_REMOTE_DIR:-~/bridge-ui}"
BRIDGE_CONTAINER="${BRIDGE_CONTAINER:-}"

YAML_TOOL="$KIT_ROOT/tools/yaml_promote.mjs"
DETECT="$KIT_ROOT/tools/detect_admin_mode.mjs"
SAFE_TX="$KIT_ROOT/tools/build_safe_tx.mjs"
PROPOSAL="$KIT_ROOT/tools/build_proposal.mjs"

[ -f "$YAML_TOOL" ] || { echo "FATAL: $YAML_TOOL missing"; exit 1; }

ensure_tools_deps() {
  if [ ! -d "$KIT_ROOT/tools/node_modules/yaml" ]; then
    echo "[promote] tools/node_modules missing — running npm install..."
    (cd "$KIT_ROOT/tools" && npm install --silent)
  fi
}

# Run the yaml tool — wraps node + tools/ deps.
yaml_cmd() {
  ensure_tools_deps
  (cd "$KIT_ROOT/tools" && node yaml_promote.mjs "$@")
}

# Re-emit state.json and push it to the bridge container.
sync_state() {
  ensure_tools_deps
  echo "[promote] regenerating state.json..."
  local UI_DIR
  if [ -d "$KIT_ROOT/../ui-v2" ]; then
    UI_DIR="$KIT_ROOT/../ui-v2"
  elif [ -d "$KIT_ROOT/ui-v2" ]; then
    UI_DIR="$KIT_ROOT/ui-v2"
  else
    UI_DIR=""
  fi

  local SRC=""
  if [ -n "$UI_DIR" ]; then
    ( cd "$KIT_ROOT/tools" && node gen_state.mjs > "$UI_DIR/state.json" )
    SRC="$UI_DIR/state.json"
    echo "[promote] wrote $SRC"
  else
    # No ui-v2/ dir — write next to addresses.yaml so the operator can
    # serve it themselves.
    SRC="$KIT_ROOT/shared/state.json"
    ( cd "$KIT_ROOT/tools" && node gen_state.mjs > "$SRC" )
    echo "[promote] no ui-v2/ found; wrote $SRC for you to serve"
  fi
  [ -f "$SRC" ] || { echo "FATAL: state.json not generated"; exit 1; }

  if [ -z "$BRIDGE_HOST" ]; then
    echo "[promote] BRIDGE_HOST unset — skipping remote push (state.json is local at $SRC)"
    return 0
  fi

  # Translate Git Bash POSIX path (/d/...) into the form scp/wsl expect.
  local SRC_FOR_TRANSPORT="$SRC"
  if command -v wsl >/dev/null 2>&1; then
    case "$SRC" in
      /[a-z]/*)
        local drive="${SRC:1:1}"
        SRC_FOR_TRANSPORT="/mnt/$drive${SRC:2}"
        ;;
    esac
  fi

  echo "[promote] pushing to $BRIDGE_HOST:$BRIDGE_REMOTE_DIR/state.json"
  if command -v wsl >/dev/null 2>&1; then
    wsl bash -c "scp '$SRC_FOR_TRANSPORT' '$BRIDGE_HOST:$BRIDGE_REMOTE_DIR/state.json'"
  else
    scp "$SRC" "$BRIDGE_HOST:$BRIDGE_REMOTE_DIR/state.json"
  fi

  if [ -n "$BRIDGE_CONTAINER" ]; then
    # First probe: is state.json bind-mounted? If yes, the scp already
    # updated the in-container file via the mount — `docker cp` would
    # fail with "device or resource busy". Detect via `docker inspect`.
    local PROBE="docker inspect $BRIDGE_CONTAINER --format '{{range .Mounts}}{{.Destination}} {{end}}' 2>/dev/null | grep -q state.json && echo bind || echo copy"
    local MOUNT_KIND
    if command -v wsl >/dev/null 2>&1; then
      MOUNT_KIND=$(wsl bash -c "ssh '$BRIDGE_HOST' \"$PROBE\"" 2>/dev/null || echo unknown)
    else
      MOUNT_KIND=$(ssh "$BRIDGE_HOST" "$PROBE" 2>/dev/null || echo unknown)
    fi
    if [ "$MOUNT_KIND" = "bind" ]; then
      echo "[promote] state.json is bind-mounted into $BRIDGE_CONTAINER — scp updated it in place, skipping docker cp"
    else
      echo "[promote] docker cp into $BRIDGE_CONTAINER (state.json was baked into the image)"
      local CP_CMD="sudo docker cp $BRIDGE_REMOTE_DIR/state.json $BRIDGE_CONTAINER:/usr/share/nginx/html/state.json"
      if command -v wsl >/dev/null 2>&1; then
        wsl bash -c "ssh '$BRIDGE_HOST' '$CP_CMD'"
      else
        ssh "$BRIDGE_HOST" "$CP_CMD"
      fi
    fi
  else
    echo "[promote] BRIDGE_CONTAINER unset — skipping docker cp (file already replaced on host; container picks it up if state.json is bind-mounted)"
  fi
}

# Read the current admin mode by inspecting a router's owner() on the
# first chain that has at least one router declared. Caller can override
# with --mode flag.
detect_mode() {
  ensure_tools_deps
  local first_chain first_router first_rpc
  read -r first_chain first_router first_rpc < <(node -e '
    const fs=require("fs"); const yaml=require("yaml");
    const d=yaml.parseDocument(fs.readFileSync(process.argv[1],"utf8"));
    const chains=d.get("chains");
    for (const item of chains.items) {
      const ck=item.key.value; const c=item.value;
      const routers=c.get("routers"); if(!routers || !routers.items) continue;
      const r=routers.items[0]?.value?.get("address");
      const rpc=(c.get("rpcUrls")?.items||[])[0]?.value;
      if (r && rpc) { console.log(ck, r, rpc); process.exit(0); }
    }
    process.exit(2);
  ' "$KIT_ROOT/shared/addresses.yaml")
  if [ -z "$first_router" ]; then
    echo "broadcast"  # no routers yet — first deploy
    return
  fi
  (cd "$KIT_ROOT/tools" && RPC="$first_rpc" ROUTER="$first_router" node detect_admin_mode.mjs) || echo "unknown"
}

# Capture the new ISM addresses that update_ism.mjs writes to ism_history.json,
# then write them back into addresses.yaml.
sync_yaml_with_history() {
  local hist="$KIT_ROOT/deployer/ism_history.json"
  [ -f "$hist" ] || return 0
  # Get the most recent entry (last in array).
  local last_isms
  last_isms=$(node -e '
    const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
    const last=j[j.length-1];
    if (!last || !last.deployedIsms) process.exit(0);
    for (const [k,v] of Object.entries(last.deployedIsms)) console.log(k, v);
  ' "$hist")
  while IFS=' ' read -r chain ism; do
    [ -z "$chain" ] && continue
    yaml_cmd set-ism "$chain" "$ism" >/dev/null
    echo "  yaml: $chain ism → $ism"
  done <<<"$last_isms"
}

#  ── COMMANDS ──────────────────────────────────────────────────────

case "$CMD" in

  add-validator)
    ADDR="${1:?usage: add-validator <addr> [--mode <broadcast|safe-tx|proposal>]}"
    shift
    MODE=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --mode) MODE="$2"; shift 2;;
        *) echo "unknown arg: $1"; exit 2;;
      esac
    done

    echo "[promote] add-validator $ADDR"
    yaml_cmd add-validator "$ADDR"

    # Compute new full validator set (union, dedup).
    VALIDATORS=$(yaml_cmd show | node -e '
      const s=JSON.parse(require("fs").readFileSync(0,"utf8"));
      // Take union across all chains (should be the same set across chains anyway).
      const all=new Set();
      for (const c of Object.values(s.chains)) for (const v of c.ismValidators) all.add(v.toLowerCase());
      console.log(Array.from(all).join(","));
    ')
    : "${THRESHOLD:=1}"  # default threshold 1 — admin overrides via env

    if [ -z "$MODE" ]; then
      MODE=$(detect_mode)
      echo "[promote] auto-detected admin mode: $MODE"
    fi

    case "$MODE" in
      broadcast)
        # Phase 1 — run the existing update_ism flow.
        echo "[promote] broadcasting via update_ism.mjs"
        bash "$KIT_ROOT/deployer/_run_deploy.sh" update_ism.mjs \
          -e VALIDATORS="$VALIDATORS" \
          -e THRESHOLD="$THRESHOLD"
        sync_yaml_with_history
        ;;
      safe-tx)
        # Phase 2 — emit a Safe tx JSON per router; admin imports each
        # into the Safe Transaction Builder, collects signatures.
        echo "[promote] Phase 2 detected — emitting Safe-tx artifacts under $KIT_ROOT/deployer/artifacts/"
        mkdir -p "$KIT_ROOT/deployer/artifacts"
        STAMP=$(date -u +%Y%m%dT%H%M%SZ)

        # First we still need to DEPLOY the new ISM (CREATE2, permissionless,
        # any wallet can do it — only the swap is owner-gated). Use the same
        # _run_deploy.sh path with the EXISTING deployer key + skip-swap env.
        # If you don't want to broadcast even the ISM deploy, set
        # SKIP_ISM_DEPLOY=1 and pre-deploy via your own script.
        if [ -z "${SKIP_ISM_DEPLOY:-}" ]; then
          echo "[promote] deploying new ISM via factory (broadcast — permissionless)"
          bash "$KIT_ROOT/deployer/_run_deploy.sh" update_ism.mjs \
            -e VALIDATORS="$VALIDATORS" \
            -e THRESHOLD="$THRESHOLD" \
            -e SKIP_ROUTER_SWAP=1
          sync_yaml_with_history
        fi

        # Now emit a Safe-tx per router per chain.
        node -e '
          const fs=require("fs"); const yaml=require("yaml");
          const d=yaml.parseDocument(fs.readFileSync(process.argv[1],"utf8"));
          const chains=d.get("chains");
          for (const item of chains.items) {
            const ck=item.key.value; const c=item.value;
            const ism=c.get("ism"); const rpcUrls=c.get("rpcUrls");
            const rpc=rpcUrls?.items?.[0]?.value;
            const chainId=Number(c.get("chainId"));
            const routers=c.get("routers");
            if (!ism || !rpc || !routers?.items) continue;
            const safe=c.get("multisig");
            if (!safe || safe==="0x0000000000000000000000000000000000000000") {
              console.error(`[promote] WARN: chain ${ck} has no multisig in addresses.yaml — skipping`);
              continue;
            }
            for (const r of routers.items) {
              const sym=r.key.value;
              const addr=r.value.get("address");
              console.log(`${ck}/${sym}|${addr}|${ism}|${safe}|${chainId}`);
            }
          }
        ' "$KIT_ROOT/shared/addresses.yaml" | while IFS='|' read -r label router ism safe cid; do
          out="$KIT_ROOT/deployer/artifacts/safe-tx-${STAMP}-${label//\//-}.json"
          ROUTER="$router" ISM="$ism" SAFE="$safe" CHAIN_ID="$cid" \
            node "$SAFE_TX" > "$out"
          echo "  emitted: $out"
        done
        echo
        echo "[promote] Phase 2 NEXT:"
        echo "  1. Open each safe-tx-*.json in the Safe Transaction Builder."
        echo "  2. Collect M-of-N signatures from the multisig signers."
        echo "  3. Execute via the Safe UI. The router ISM swap completes when the Safe tx lands."
        ;;
      proposal)
        # Phase 3 — emit Governor proposal payload (single proposal can
        # batch all router setIsm calls). The DAO frontend posts targets/
        # values/calldatas/description to Governor.propose().
        echo "[promote] Phase 3 detected — emitting Governor proposal artifacts under $KIT_ROOT/deployer/artifacts/"
        mkdir -p "$KIT_ROOT/deployer/artifacts"
        STAMP=$(date -u +%Y%m%dT%H%M%SZ)

        # ISM deploy (still permissionless) unless caller wants to skip.
        if [ -z "${SKIP_ISM_DEPLOY:-}" ]; then
          bash "$KIT_ROOT/deployer/_run_deploy.sh" update_ism.mjs \
            -e VALIDATORS="$VALIDATORS" \
            -e THRESHOLD="$THRESHOLD" \
            -e SKIP_ROUTER_SWAP=1
          sync_yaml_with_history
        fi

        # One proposal per chain (each chain has its own Governor / Timelock).
        node -e '
          const fs=require("fs"); const yaml=require("yaml");
          const d=yaml.parseDocument(fs.readFileSync(process.argv[1],"utf8"));
          const chains=d.get("chains");
          for (const item of chains.items) {
            const ck=item.key.value; const c=item.value;
            const ism=c.get("ism");
            const routers=c.get("routers");
            if (!ism || !routers?.items) continue;
            const addrs=routers.items.map(r => r.value.get("address")).filter(Boolean);
            if (addrs.length===0) continue;
            console.log(`${ck}|${addrs.join(",")}|${ism}`);
          }
        ' "$KIT_ROOT/shared/addresses.yaml" | while IFS='|' read -r ck routers ism; do
          out="$KIT_ROOT/deployer/artifacts/proposal-${STAMP}-${ck}.json"
          ROUTERS="$routers" ISM="$ism" \
            DESCRIPTION="Update ISM to $ism on ${ck} routers — promote-operator $STAMP" \
            node "$PROPOSAL" > "$out"
          echo "  emitted: $out"
        done
        echo
        echo "[promote] Phase 3 NEXT:"
        echo "  1. Post each proposal-*.json to the DAO forum."
        echo "  2. After vote passes + Timelock delay, anyone can call Governor.execute()."
        ;;
      *)
        echo "ERR unknown mode '$MODE' — use broadcast | safe-tx | proposal"
        exit 1
        ;;
    esac

    sync_state
    echo "[promote] DONE — add-validator $ADDR (mode=$MODE)"
    ;;

  remove-validator)
    ADDR="${1:?usage: remove-validator <addr> [--mode ...]}"
    shift
    MODE=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --mode) MODE="$2"; shift 2;; *) shift;; esac
    done

    yaml_cmd remove-validator "$ADDR"
    VALIDATORS=$(yaml_cmd show | node -e '
      const s=JSON.parse(require("fs").readFileSync(0,"utf8"));
      const all=new Set();
      for (const c of Object.values(s.chains)) for (const v of c.ismValidators) all.add(v.toLowerCase());
      console.log(Array.from(all).join(","));
    ')
    : "${THRESHOLD:=1}"

    if [ -z "$MODE" ]; then MODE=$(detect_mode); fi

    case "$MODE" in
      broadcast)
        bash "$KIT_ROOT/deployer/_run_deploy.sh" update_ism.mjs \
          -e VALIDATORS="$VALIDATORS" \
          -e THRESHOLD="$THRESHOLD"
        sync_yaml_with_history
        ;;
      safe-tx|proposal)
        echo "[promote] $MODE: re-run add-validator <existing addr> to re-emit artifacts with the smaller set"
        echo "       (same code path; just specifies the new VALIDATORS)"
        ;;
    esac
    sync_state
    echo "[promote] DONE — remove-validator $ADDR"
    ;;

  add-relayer)
    NAME="${1:?usage: add-relayer <name> <role> <delay_ms> <chain1=0x...,chain2=0x...>}"
    ROLE="${2:-unspecified}"
    DELAY_MS="${3:-0}"
    SIGNERS="${4:?signers map required}"

    yaml_cmd add-relayer "$NAME" "$ROLE" "$DELAY_MS" "$SIGNERS"
    sync_state
    echo "[promote] DONE — add-relayer $NAME ($ROLE, +${DELAY_MS}ms)"
    ;;

  remove-relayer)
    NAME="${1:?usage: remove-relayer <name>}"
    yaml_cmd remove-relayer "$NAME"
    sync_state
    echo "[promote] DONE — remove-relayer $NAME"
    ;;

  sync-state)
    sync_state
    ;;

  show)
    yaml_cmd show
    ;;

  *)
    echo "unknown command: $CMD"
    echo "usage:
  bash promote_operator.sh add-validator <addr> [--mode broadcast|safe-tx|proposal]
  bash promote_operator.sh remove-validator <addr> [--mode ...]
  bash promote_operator.sh add-relayer <name> <role> <delay_ms> \"chain=0x...,chain=0x...\"
  bash promote_operator.sh remove-relayer <name>
  bash promote_operator.sh sync-state
  bash promote_operator.sh show"
    exit 2
    ;;
esac
