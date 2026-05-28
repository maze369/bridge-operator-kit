# Bridge Overview

**Audience:** anyone running a validator, relayer, or deployer role on
a Hyperlane bridge built from this kit.
**Goal of this doc:** 10-minute intro to what the kit does, what each
role is responsible for, and how the four standard operations
(`ADD_VALIDATOR` / `ADD_RELAYER` / `ADD_CHAIN` / `ADD_TOKEN`) work.

## What this kit gives you

A turnkey package for running a multi-validator, multi-relayer
[Hyperlane](https://hyperlane.xyz/) bridge between any set of
EVM-compatible chains. It bundles:

- **Standard Hyperlane v3 primitives** — `Mailbox`, `MerkleTreeHook`,
  `ValidatorAnnounce`, `StaticMessageIdMultisigIsm` — plus warp
  routers per token (`HypNative`, `HypERC20Collateral`, `HypERC20`,
  `HypXERC20`). No custom cryptography. The decentralization story
  lives in **who** runs the validators and relayers + **how** ISM
  admin authority is held (operator-key → multisig → DAO).
- **Stagger sidecar** — fronts each relayer's `eth_sendRawTransaction`
  with a configurable per-relayer delay and a pre-flight
  `mailbox.delivered(mid)` check, so a pool of N relayers stays
  race-free without gas-wars. Higher-priority relayers fire first;
  warm spares only spend gas if the primary is down.
- **`promote_operator.sh`** — one-command admin (add/remove
  validator, add/remove relayer, sync UI state). Auto-detects whether
  router ownership is an EOA, Gnosis Safe, or OZ Governor + Timelock
  and emits the right payload for each phase. Same UX everywhere.
- **`verify_bridge_health.mjs`** — public verifier. Reads
  `shared/addresses.yaml` and checks every declared address against
  on-chain state. No keys needed.

## The five roles

| Role | What you do | Read |
|---|---|---|
| **Validator** | Watch one or more origin chains, sign each new merkle root, publish to your sig bucket (S3/R2 or localStorage). One container per chain you watch. | `validator/README.md` |
| **Relayer** | Watch every chain, fetch checkpoints from validators' buckets, submit `process()` on the destination chain. Stagger sidecar enforces your delay tier. | `relayer/README.md` |
| **Multisig signer** (Phase 2+) | Hold a Safe seat that controls ISM + router admin. Sign Safe transactions emitted by `promote_operator.sh`. | `multisig/README.md` |
| **Deployer** | Deploy Hyperlane core on a new chain; deploy warp routers; cross-enroll; run `update_ism.mjs` when the validator set changes. | `deployer/README.md` |
| **Verifier** | No key needed — run `verify_bridge_health.mjs` to confirm declared addresses match on-chain. | `recovery/README.md` |

## The four standard operations

| Operation | Runbook | What it does |
|---|---|---|
| `ADD_VALIDATOR` | `runbooks/ADD_VALIDATOR.md` | A new operator generates a key, runs the validator agent, gets the operator-key/Safe/DAO to deploy a new ISM with their address included, swap routers to the new ISM. |
| `ADD_RELAYER` | `runbooks/ADD_RELAYER.md` | A new operator generates per-chain signers, funds them, picks a stagger delay (primary / warm-spare / cold-spare), starts the agent. Off-chain only — relayer set is admin-curated in `addresses.yaml`. |
| `ADD_CHAIN` | `runbooks/ADD_CHAIN.md` | Deploy Hyperlane core on a new chain; add to `addresses.yaml` + `agent-config.json`; existing validators + relayers extend their `CHAINS_TO_WATCH` / `RELAY_CHAINS` lists; first warp router pair goes live. |
| `ADD_TOKEN` | `runbooks/ADD_TOKEN.md` | Pick a router kind (HypNative / HypERC20Collateral / HypERC20 / HypXERC20), deploy on both sides, cross-enroll, optionally swap to a per-token ISM. |

Each operation can be done with **no coordination beyond the admin
authorization** — operators don't need the admin's permission to start
running an agent; the only gated step is being included in the ISM.

## What you DON'T need

- Read the Hyperlane source code.
- Coordinate with other operators except once, at the start, to share
  your public validator address + sig bucket URL.
- Wait on the admin to "approve" your container running. Mailbox is
  permissionless; `ValidatorAnnounce` is permissionless. The only
  gated step is being added to the active ISM via owner-gated calls.

## Threat model in one paragraph

This is a **social + reputational** trust model, not cryptoeconomic.
Hyperlane v3 has no slashing — if a validator signs a fraudulent
message, the worst case is a bridge drain and that operator's name on
chain forever. There's no stake to forfeit. The bridge's security
therefore depends on: (1) the validator set being independent operators
who won't collude, (2) the threshold being high enough that any single
defection is harmless, (3) the admin (EOA / multisig / DAO) that owns
the contracts being trustworthy. The kit makes (3) tractable by
shipping the same admin command surface for all three governance
phases — you start with an operator key, transition to a Safe when
ready, transition to a Governor + Timelock when ready, with no agent
or runbook changes along the way.

## Phase progression

Same code, three authorization modes:

| Phase | `router.owner()` | `promote_operator.sh` behavior |
|---|---|---|
| 1 — Bootstrap | EOA (operator key) | Broadcasts txs directly |
| 2 — Multisig | Gnosis Safe | Emits Safe Transaction Builder JSON |
| 3 — DAO | OZ Governor + Timelock | Emits Governor proposal payload |

Transitions are one-way (`transferOwnership` → new owner). Agents
don't need to know which phase the bridge is in — they read
`addresses.yaml` for the active validator set.

## Upstream

This kit is intended for upstream contribution to the
[Drive](https://github.com/deep-thought-labs/drive) framework as
`services/bridge-validator/`, `services/bridge-relayer/`, and
`tools/bridge/`.

## Reading order for a new operator

1. **This doc** (you're here).
2. **Pick your role and read its README** in the listed subdirectory.
3. **Pick a runbook** under `runbooks/` matching the operation you're
   asked to do.
4. **`shared/addresses.example.yaml`** — the shape of the per-bridge
   state file (your bridge's `addresses.yaml` will look similar with
   real addresses filled in).
