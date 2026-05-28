# Runbook: Add a Token

Deploy a warp-router pair for a new asset, cross-enroll, optionally
wire a per-token ISM, register, and smoke-test. Typically <1 hour
calendar time once both chains are registered in `chains/`.

## Pre-conditions

- [ ] Both source + destination chains already have Hyperlane core
  deployed and listed as `chains/<key>/chain.yaml` presets. If a
  chain isn't there yet, do **`ADD_CHAIN.md`** first.
- [ ] You have a deployer key with native gas on both chains. Budget:
  ~$1 total on most L2s.
- [ ] You've picked which `kind` each side is (decision matrix below).

## Token-kind decision matrix

| Source side is... | Source kind | Destination kind |
|---|---|---|
| **Native gas token** (the chain's native asset) | `HypNative` | `HypERC20` (synthetic) |
| **ERC20 with canonical home on this chain** | `HypERC20Collateral` | `HypERC20` (synthetic) |
| **ERC20 mirrored from elsewhere** | `HypERC20Collateral` | `HypERC20` (synthetic) |
| **EIP-7281 xERC20** (mint/burn with per-bridge rate limits) | `HypXERC20` | `HypXERC20` |
| **Both sides have the same underlying already** (rare — dual collateral pools) | `HypERC20Collateral` | `HypERC20Collateral` |

For 99% of real cases: source uses `HypNative` or `HypERC20Collateral`
(locks funds); destination uses `HypERC20` (mints/burns the synthetic).

`HypXERC20` is the modern alternative for projects that want a single
token contract on every chain with per-bridge mint/burn limits enforced
in the underlying — see the EIP-7281 spec.

## Routers schema

The router list under each chain in `shared/addresses.yaml`:

```yaml
chains:
  chain-a:
    routers:
      # KEY = the symbol of the asset ON THIS CHAIN.
      # (the underlying's symbol for HypNative / HypERC20Collateral,
      #  the h-prefixed symbol for HypERC20 synthetics)
      NATIVE:                                  # native on chain-a
        kind: HypNative
        address: "0x..."
      USDC:                                    # collateral on chain-a
        kind: HypERC20Collateral
        address: "0x..."
        underlying: "0x..."
      hNATIVE_B:                               # synthetic for chain-b-side native
        kind: HypERC20
        address: "0x..."
        decimals: 18

  chain-b:
    routers:
      NATIVE_B:                                # native on chain-b
        kind: HypNative
        address: "0x..."
      hNATIVE:                                 # synthetic for chain-a-side native
        kind: HypERC20
        address: "0x..."
        decimals: 18
      hUSDC:                                   # synthetic for chain-a-side USDC
        kind: HypERC20
        address: "0x..."
        decimals: 6
```

No `symbol:` field — the YAML key is the symbol. Decimals on the
synthetic MUST match the underlying — bridging 6-decimal USDC into an
18-decimal synthetic loses fractional precision.

---

## Step 1 — Pick names + symbols

Naming convention: source-side router uses the asset's existing symbol;
destination synthetic prepends `h` for "Hyperlane-issued":

| Source asset | Source symbol/key | Destination synthetic key |
|---|---|---|
| Native gas token of chain-a | NATIVE | hNATIVE |
| USDC (ERC20 on chain-a) | USDC | hUSDC |

---

## Step 2 — Deploy source-side router

```bash
cd <kit-root>
DEPLOYER_KEY_FILE=/path/to/admin.key \
SRC_CHAIN=<source-chain-key> \
ROUTER_KIND=HypNative \
bash deployer/_run_deploy.sh deploy_warp_router.mjs
```

For an ERC20 source (HypERC20Collateral), pass the underlying token
address:

```bash
DEPLOYER_KEY_FILE=/path/to/admin.key \
SRC_CHAIN=<source-chain-key> \
ROUTER_KIND=HypERC20Collateral \
UNDERLYING=0x...<erc20-token-address>... \
bash deployer/_run_deploy.sh deploy_warp_router.mjs
```

Script behavior (`deploy_warp_router.mjs`):
- Reads RPC + mailbox from `chains/<chain>/chain.yaml`.
- Deploys the router contract.
- Writes `deployer/warp_<symbol_or_kind>_<chain>.json` with all
  artifacts (`address`, `mailbox`, `deployer`, `txHash`, `deployBlock`,
  `kind`, `underlying`).
- Idempotent — re-running with the same args + a previously-saved
  output JSON just prints "REUSE" and exits.

---

## Step 3 — Deploy destination-side router

```bash
DEPLOYER_KEY_FILE=/path/to/admin.key \
DST_CHAIN=<destination-chain-key> \
ROUTER_KIND=HypERC20 \
SYMBOL=hNATIVE \
NAME="Hyperlane Native" \
DECIMALS=18 \
bash deployer/_run_deploy.sh deploy_warp_router.mjs
```

This deploys a `HypERC20` synthetic AND calls
`initialize(0, NAME, SYMBOL)` in one tx. The script writes
`deployer/warp_<SYMBOL>_<chain>.json`.

For `HypXERC20`, the symbol/name are taken from the underlying xERC20
contract (you must have deployed it separately first); pass
`UNDERLYING=` instead of `SYMBOL/NAME/DECIMALS`.

---

## Step 4 — Cross-enroll

Each router needs to know which router on the OTHER chain corresponds
to it. Otherwise messages can't be routed.

```bash
DEPLOYER_KEY_FILE=/path/to/admin.key \
SRC_CHAIN=<source-chain-key> \
SRC_ROUTER=0x<src-router-from-step-2> \
DST_CHAIN=<destination-chain-key> \
DST_DOMAIN=<destination-domain> \
DST_ROUTER=0x<dst-router-from-step-3> \
bash deployer/_run_deploy.sh enroll_pair.mjs
```

`enroll_pair.mjs` reads the source domain from `chain.yaml`. What it does:

1. On source: `srcRouter.enrollRemoteRouter(dstDomain, padded(dstRouter))`
2. On destination: `dstRouter.enrollRemoteRouter(srcDomain, padded(srcRouter))`

Both calls are owner-gated. Phase 1: the deployer key owns both
routers. Phase 2+: this becomes a multisig proposal — `promote_operator.sh`
will emit Safe Transaction Builder JSON for the enrollment txs.

Idempotent — if an enrollment is already correct, the script logs
`ALREADY enrolled` and skips.

---

## Step 5 — Wire a router-specific ISM (optional)

By default, routers use the chain's default ISM (set during `ADD_CHAIN`).
Skip this step unless you want a token-specific ISM — e.g., higher
threshold for a high-value asset, or a lower one for an experimental
low-stakes token.

```bash
DEPLOYER_KEY_FILE=/path/to/admin.key \
CHAIN=<chain-key> \
ROUTER=0x<router-address> \
ISM=0x<ism-address> \
bash deployer/_run_deploy.sh set_router_ism.mjs
```

For most assets, skip — the default ISM is fine.

---

## Step 6 — Update `shared/addresses.yaml`

Append the new routers under each chain's `routers:` section, per the
schema documented at the top of this runbook. Add the cross-enrollment
records under the top-level `enrollments:` block:

```yaml
enrollments:
  # ... existing ...
  - source: <source-chain>:<source-symbol>
    dest: <destination-chain>:<destination-symbol>
  - source: <destination-chain>:<destination-symbol>
    dest: <source-chain>:<source-symbol>
```

`enrollments` is for verification — `verify_bridge_health.mjs` checks
the on-chain enrollments match this list. On-chain is the source of
truth; this list is just for human review.

Commit + push.

---

## Step 7 — Smoke transfer

Bridge a small amount end-to-end and verify delivery. Easiest path: use
the bridge UI's "test bridge" flow, or write a 20-line script that
calls `transferRemote(dstDomain, recipientPadded, amount)` on the
source router and polls `Mailbox.delivered(messageId)` on the
destination side.

Expected behavior:
- Forward leg delivers in ~20-60s (after the validator's signing
  interval + relayer's stagger delay).
- Reverse leg (send back) delivers in the same time.
- Destination balance increases by the bridged amount; source balance
  decreases by the same.

If only the forward leg works: enrollment direction is asymmetric —
re-run step 4 in the failing direction.

---

## Step 8 — Register in the public UI

Per-bridge: edit the UI's token registry (each bridge deployment has
its own). If your UI reads from `shared/state.json` (auto-generated
by `tools/gen_state.mjs`), nothing to do — running
`bash tools/promote_operator.sh sync-state` regenerates state.json
from `addresses.yaml` and pushes to the UI host.

If your UI hardcodes a token list, add the new token to its routes
config + rebuild.

---

## Common failures + fixes

| Symptom | Cause | Fix |
|---|---|---|
| `enrollRemoteRouter` reverts with `Ownable: caller is not the owner` | Running with a non-owner key | Use the deployer key that owns the router. In Phase 2+ this becomes a Safe proposal — use `promote_operator.sh` to emit the right payload. |
| Smoke transfer's destination leg never delivers | Enrollment missing in one direction | Re-run `enroll_pair.mjs` — it's idempotent. |
| Synthetic balance is 0 even after `delivered=true` | Recipient address padding wrong — `bytes32` not `address` | Always use `ethers.zeroPadValue(addr, 32)` for the recipient field. `transferRemote` takes bytes32. |
| Native transfer reverts `InsufficientValue` | `HypNative.transferRemote` requires `msg.value >= amount` | Match `value` to `amount` exactly. |
| `transferRemote` reverts with unexpected IGP charge | Interchain Gas Paymaster wired by mistake | `chains/<chain>/chain.yaml` doesn't have IGP — the agent reads `interchainGasPaymaster: 0x0` and skips IGP. If it's misconfigured upstream, drop the IGP address back to the zero address. |
| `deploy_warp_router.mjs` errors `chain "xyz" has no mailbox` | The chain isn't in `chains/` yet | Run `ADD_CHAIN.md` first. |
| `HypXERC20` reverts on first transferRemote with `RATE_LIMIT_REACHED` | Bridge limits weren't set on the xERC20 token | Call `xerc20.setLimits(router, mintLimit, burnLimit)` from the xERC20 owner first. |
