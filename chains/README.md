# Chain presets

Each subdirectory under `chains/` is a **preset for one chain**. A
preset bundles:

```
chains/<key>/
├── chain.yaml          # all chain facts (RPC, mailbox, gas, finality, ...)
└── validator/          # ready-to-run validator scaffold
    ├── chain-info.md   # auto-rendered description (chain.yaml summary)
    ├── docker-compose.yml
    ├── drive.sh        # `./drive.sh up -d` to start the validator
    ├── .env.example    # operator-local fields only (key, bucket, operator name)
    └── 01_setup.sh     # generate a fresh validator key
```

To **run a validator for a given chain**:

```bash
cd chains/<key>/validator
cp .env.example .env
# edit .env: OPERATOR_NAME, bucket credentials
bash 01_setup.sh          # generates VALIDATOR_KEY
./drive.sh up -d
```

No chain config to edit. The RPCs, mailbox address, gas overrides etc.
all come from `chain.yaml`. drive.sh runs `tools/build_agent_config.mjs`
on every `up` to merge every preset's `chain.yaml` into a single
`shared/agent-config.json` that the agent mounts.

## Running for multiple chains

Run the steps above once per chain. The validator key is the same
across chains (one validator identity per operator across the whole
bridge), so after generating it in your first chain dir, copy the
`VALIDATOR_KEY=…` line into each subsequent chain's `.env`.

```bash
cd chains/example-mainnet/validator && bash 01_setup.sh
KEY=$(grep ^VALIDATOR_KEY= .env)
cd ../../example-testnet/validator
cp .env.example .env
sed -i "s|^VALIDATOR_KEY=.*|$KEY|" .env
# edit OPERATOR_NAME etc.
./drive.sh up -d
```

Each chain runs as its own docker compose project
(`<chain>-validator-<operator>`), so they don't share volumes or
network namespaces.

## Adding a new chain preset

To onboard a brand-new chain to the kit:

```bash
cp -r chains/_template chains/<your-key>
# edit chains/<your-key>/chain.yaml — fill in chainId, RPCs, etc.
# leave the hyperlane:* addresses as 0x0 until you've deployed Hyperlane
# core on this chain (see runbooks/ADD_CHAIN.md).
```

Commit the new directory. Every operator who pulls the update gets the
new preset automatically — they just `cd chains/<your-key>/validator`
and follow the standard setup.

If the chain uses Cosmos SDK + the Hyperlane `warp` module (rather
than EVM contracts), set `protocol: cosmosnative` in `chain.yaml` and
add `bech32Prefix:` + `grpcUrls:`. See `_template/chain.yaml` for the
full schema.

## What's in `_template/`

The blueprint. **Don't run it** — `chain.yaml` has placeholder
`example-chain` values and the agents will fail to connect. It's
strictly the source of truth for "what fields exist + what each one
does." When you `cp -r _template <new>`, you start from a working
schema.

## Where the cross-chain admin state lives

`chain.yaml` is per-chain facts. The cross-chain state — current ISM
address, validator set, threshold, router enrollments, relayer roster
— lives in `shared/addresses.yaml` (which is per-bridge, not committed
to this upstream kit). See `OVERVIEW.md` and `runbooks/`.
