# Deployer Kit

One-time setup, run by the launching team. After running, no one (not
even you) has admin power outside the multisig — provided you transfer
ownership at the end.

## Prerequisites

- Node 20+, Docker, git, curl, python3 (with `pyyaml` for `00_prereq_check.sh`)
- Funded EVM deployer key on every chain in scope (~$50-100 native each
  for L2s; more on L1s)
- For Phase 2+: the multisig signer addresses, finalized
- The initial validator addresses (collected from validator operators
  who've run `validator/01_setup.sh`)
- All chain RPCs known + tested

## Configuration

All scripts route through `_run_deploy.sh`, which reads:

| Env var | Purpose | Default |
|---|---|---|
| `DEPLOYER_KEY` | 0x-prefixed hex deployer/admin key | — required (or use `DEPLOYER_KEY_FILE`) |
| `DEPLOYER_KEY_FILE` | path to a file containing a 0x...64hex key | — |
| `KIT_ROOT` | absolute path to your operator-kit checkout | parent of `deployer/` |
| `DOCKER_NETWORK` | docker network to attach the runner to | `bridge` |

Export `DEPLOYER_KEY` once per shell session, then run scripts directly.

## Sequence

```bash
# 0. Verify the deploy environment
bash 00_prereq_check.sh

# 1. Build shared config from chain set
#    Edit ../shared/addresses.example.yaml → ../shared/addresses.yaml
#    Edit ../shared/agent-config.json (RPCs, reorgPeriod, chain blocks)

# 2. (Phase 2+) Deploy a Gnosis Safe on every chain (see ../multisig/README.md).
#    Phase 1 = single operator-key. Skip step 2 entirely.

# 3. Deploy Hyperlane core on each chain (only if it doesn't already have it)
NEW_CHAIN=mychain LOCAL_DOMAIN=1234 RPC=https://rpc.mychain.org \
  VALIDATORS=0xv1,0xv2,0xv3 THRESHOLD=2 \
  bash _run_deploy.sh deploy_evm_core.mjs

# 4. Deploy each warp router (per token per chain)
SRC_CHAIN=mychain ROUTER_KIND=HypNative \
  bash _run_deploy.sh deploy_warp_router.mjs

DST_CHAIN=destchain SYMBOL=hMYTOK ROUTER_KIND=HypERC20 NAME="Hyperlane MyTok" \
  bash _run_deploy.sh deploy_warp_router.mjs

# 5. Cross-enroll routers
SRC_CHAIN=mychain SRC_ROUTER=0x... \
  DST_CHAIN=destchain DST_ROUTER=0x... \
  bash _run_deploy.sh enroll_pair.mjs

# 6. (Optional) Per-router ISM override
CHAIN=mychain ROUTER=0x... ISM=0x... \
  bash _run_deploy.sh set_router_ism.mjs

# 7. Smoke transfer — call transferRemote() once in each direction, poll
#    Mailbox.delivered(messageId) on the destination, confirm balance moved.
#    Use the bridge UI's "test bridge" flow or a 20-line ethers script.

# 8. (Phase 2+) Transfer router + ISM ownership to multisig
#    No turnkey script yet — use Etherscan / a one-off ethers call to
#    `transferOwnership(multisig)` on every router and the ISM (if Ownable).
#    This is THE GATE — after running it, the deployer EOA loses admin power.

# 9. Verify the deploy
node ../recovery/verify_bridge_health.mjs
```

## Files in this directory

| File | What it does |
|---|---|
| `_run_deploy.sh` | Docker runner — installs ethers@5 + @hyperlane-xyz/core@3.1.10 inside a node:20 container, mounts `$KIT_ROOT` at `/work`, passes `DEPLOYER_KEY` as `HYP_KEY` |
| `00_prereq_check.sh` | Sanity checks: tools, configs, deployer key, RPC reachability |
| `deploy_evm_core.mjs` | Step 3 — deploy ISM factory + ISM + Mailbox + MerkleTreeHook + ValidatorAnnounce + initialize Mailbox |
| `deploy_warp_router.mjs` | Step 4 — deploy HypNative / HypERC20Collateral / HypERC20 |
| `enroll_pair.mjs` | Bidirectional `enrollRemoteRouter` between a fresh router pair |
| `set_router_ism.mjs` | `router.setInterchainSecurityModule(ism)` on a single router |
| `update_ism.mjs` | Deploy a new multisig ISM (via the factory) and swap it into every warp router on the affected chain(s). Used by `promote_operator.sh add-validator / remove-validator`. |
| `promote_operator.sh` | One-command admin: add/remove validator, add/remove relayer, sync UI state. Auto-detects Phase 1 / 2 / 3 admin mode and emits the right payload (broadcast tx / Safe-tx JSON / Governor proposal). |

## Critical invariants to verify after deployment (Phase 2+)

After transferring ownership, ALL of these must be true:

```
[ ] Every router's owner() returns the multisig address
[ ] Every router's interchainSecurityModule() returns the deployed ISM
[ ] ISM's owner() returns the multisig (Phase 3+: Timelock)
[ ] Deployer EOA's nonce on each chain is "done" — no further admin actions
[ ] No router has an admin function callable by deployer EOA
[ ] Mailbox is non-upgradable (matches expected codehash)
[ ] Multisig has the documented signer set + threshold
```

Run `../recovery/verify_bridge_health.mjs` — when `owner: multisig` is set
on each chain in `addresses.yaml`, it checks every line above.

If any check fails, DO NOT publish addresses or invite users to bridge.
Fix or redeploy first.
