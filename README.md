# Bridge Operator Kit

Turnkey package for running a multi-validator [Hyperlane](https://hyperlane.xyz/)
bridge across any set of EVM (and EVM-compatible) chains.

The kit ships:
- **Per-chain presets** under `chains/<key>/` — each containing the
  chain's RPCs, Hyperlane addresses, gas overrides + a ready-to-run
  validator scaffold. Operators `cd` into the chain they want to
  support and `drive.sh up`. No CHAINS_TO_WATCH lists, no compose
  editing.
- **Relayer** at the top level (cross-chain by design) — one instance
  per operator covers any subset of chains; per-chain signer keys +
  RPC overrides are pre-wired from the same `chain.yaml` files.
- **Deployer scripts** — deploy Hyperlane core (Mailbox, ISM factory,
  MerkleTreeHook, ValidatorAnnounce) + warp routers (HypNative,
  HypERC20Collateral, HypERC20, HypXERC20) on any EVM chain.
- **`promote_operator.sh`** — one-command admin (add/remove validator,
  add/remove relayer, sync UI state). Auto-detects whether router
  ownership is an EOA, Gnosis Safe, or OZ Governor and emits the right
  payload for each phase.
- **`verify_bridge_health.mjs`** — anyone (no key needed) can run this
  to verify every address declared in `shared/addresses.yaml` matches
  what's on-chain.
- **Stagger sidecar** — fronts each relayer's `eth_sendRawTransaction`
  with a configurable per-relayer delay + a pre-flight `delivered(mid)`
  check, so a pool of relayers stays race-free without gas-wars.
- **Runbooks** — `ADD_VALIDATOR`, `ADD_RELAYER`, `ADD_CHAIN`, `ADD_TOKEN`.

## Run a validator

**New here?** → Follow [**`chains/README.md`**](./chains/README.md). It walks
you from a fresh Ubuntu server through Docker install, key generation,
sig-bucket setup, and "your validator is running and signing." Takes
~30 minutes.

**Already have Docker + kit cloned?** TL;DR:

```bash
cd chains/<your-chain>/validator
cp .env.example .env
# edit .env: OPERATOR_NAME + bucket credentials
bash 01_setup.sh             # generates VALIDATOR_KEY
./drive.sh up -d
```

Repeat for every chain you want to support.

## Run a relayer

```bash
cd relayer
cp .env.example .env
# edit RELAY_CHAINS (or leave blank = all preset chains)
bash 01_setup.sh             # generates per-chain SIGNER_KEY_<X>
./drive.sh up -d
```

The stagger sidecar enforces your delay tier (primary / warm-spare /
cold-spare) so multiple relayers in a pool don't gas-war each other.

## Add a new chain

```bash
cp -r chains/_template chains/<your-key>
# edit chains/<your-key>/chain.yaml — fill in chainId, RPCs, etc.
```

Every operator who pulls the kit update gets the new preset
automatically — they `cd chains/<your-key>/validator` and follow the
standard setup. See `chains/README.md` and `runbooks/ADD_CHAIN.md`.

## Layout

```
operator-kit/
├── chains/
│   ├── _template/              # blueprint for new chain presets
│   ├── example-mainnet/        # one preset per chain
│   │   ├── chain.yaml          # all chain facts (RPC, mailbox, gas, ...)
│   │   └── validator/          # ready-to-run validator scaffold
│   │       ├── drive.sh
│   │       ├── docker-compose.yml
│   │       ├── .env.example
│   │       └── 01_setup.sh
│   └── example-testnet/
├── relayer/                    # ONE relayer, multi-chain by design
├── deployer/                   # admin: Hyperlane core, warp routers, ISMs
├── tools/                      # promote_operator.sh, build_agent_config.mjs, ...
├── runbooks/                   # ADD_VALIDATOR / ADD_RELAYER / ADD_CHAIN / ADD_TOKEN
├── multisig/                   # docs for Phase 2 multisig signers
├── recovery/                   # verify_bridge_health.mjs (read-only verifier)
└── shared/
    ├── agent-config.example.json    # auto-generated structure reference
    └── addresses.example.yaml       # cross-chain admin state template
```

`chain.yaml` is the per-chain source of truth (committed to the kit).
`shared/agent-config.json` is auto-generated from all `chain.yaml` files
on every `drive.sh up`. `shared/addresses.yaml` is per-bridge admin
state (gitignored in the upstream kit; committed in each bridge's own
fork or deployment repo).

## Pick a role

| If you are... | Read |
|---|---|
| **A validator operator** | [`chains/README.md`](./chains/README.md) |
| **A relayer operator** | [`relayer/README.md`](./relayer/README.md) |
| **A multisig signer** (Phase 2+) | [`multisig/README.md`](./multisig/README.md) |
| **A deployer** | [`deployer/README.md`](./deployer/README.md) |
| **A verifier** | [`recovery/README.md`](./recovery/README.md) |

## Phase-aware admin (Phase 1 ↔ Phase 2 ↔ Phase 3)

Same command set, three authorization modes — `promote_operator.sh`
auto-detects which phase the bridge is in by reading `router.owner()`:

| Phase | `router.owner()` | What admin commands emit |
|---|---|---|
| 1 — Bootstrap | EOA (operator key) | Broadcast txs directly |
| 2 — Multisig | Gnosis Safe | Safe Transaction Builder JSON |
| 3 — DAO | OZ Governor + Timelock | Governor proposal payload |

The on-chain payload is identical across phases — only the
authorization vehicle changes. Transitions are one-way and require
explicit `transferOwnership` to the new owner.

## Upstream

This kit is intended for upstream contribution to the
[Drive](https://github.com/deep-thought-labs/drive) framework as
`services/bridge-validator/`, `services/bridge-relayer/`, and
`tools/bridge/`.

## License

Apache 2.0
