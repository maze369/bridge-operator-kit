# Runbook: Add a Chain

Bring a new chain into the bridge — deploy Hyperlane core on it,
register it as a `chains/<key>/` preset, then hand off to
`ADD_TOKEN.md` for the first warp router pair.

This is the most involved runbook in the kit: ~half a day of calendar
time, coordinated between the deployer (deploys Hyperlane core, edits
`chain.yaml`) and every existing validator/relayer (pulls the new
preset, restarts).

## Pre-conditions

- [ ] You have a short lowercase chain key (used as a directory name +
  YAML/JSON key everywhere — e.g. `arbitrum`, `optimism`). Lowercase
  letters, digits, dashes only.
- [ ] You know the chain's `chainId` and `domain` (almost always
  equal — domain == chainId for EVM chains).
- [ ] The chain has a public RPC + block explorer (or internal Docker
  DNS access from operators' hosts).
- [ ] A wallet holds enough native gas to deploy ~10 contracts (EVM
  path) or post ~5 txs (Cosmos-SDK + warp module path). Budget: a few
  dollars on most L2s.
- [ ] You know the chain's reorg depth — most L2s `5–10`; long-finality
  L1s 64+.

## Decision matrix

| If the new chain is... | Use |
|---|---|
| Pure EVM (Mailbox is a Solidity contract you deploy) | **Path A** — `deployer/deploy_evm_core.mjs` |
| Cosmos SDK with the Hyperlane `warp` module built into the chain binary | **Path B** — `<chaind> tx hyperlane …` CLI inside the chain's container |

Path B skips the Solidity contract deploys — the Mailbox + ISM +
MerkleTreeHook live in chain state as the `warp` module manages them.

---

## Path A — Pure EVM chain

### Step A.1 — Deploy Hyperlane core

```bash
cd <kit-root>
DEPLOYER_KEY_FILE=/path/to/admin.key \
NEW_CHAIN=<your-key> \
LOCAL_DOMAIN=<chainId> \
RPC=https://rpc.example.org \
VALIDATORS=0xv1,0xv2,0xv3 \
THRESHOLD=2 \
bash deployer/_run_deploy.sh deploy_evm_core.mjs
```

The script:
1. Deploys `StaticMessageIdMultisigIsmFactory`.
2. Creates the initial ISM via the factory (CREATE2 from
   `(validators, threshold)` — deterministic).
3. Deploys `Mailbox(LOCAL_DOMAIN)`.
4. Deploys `MerkleTreeHook(mailbox)`.
5. Deploys `ValidatorAnnounce(mailbox)`.
6. Calls `Mailbox.initialize(owner=signer, ism, merkle, merkle)` —
   passing `requiredHook=merkleTreeHook` is critical so the merkle
   root advances on every dispatch.
7. Writes `deployer/<chain>_evm_core.json` with every address.

### Step A.2 — Validator announce

EVM auto-announce works out of the box. Each validator host runs:

```bash
cd chains/<new-key>/validator
./drive.sh restart
```

On first boot, the agent calls
`ValidatorAnnounce.announce(storageLocation, signature)` once per chain
(reads the URL from `BUCKET_URL` in `.env`). The announce tx costs
~50k gas and idempotently no-ops if the same `(validator, storage)`
pair is already announced.

---

## Path B — Cosmos SDK chain with Hyperlane `warp` module

### Step B.1 — Prepare the deployer keyring

```bash
# Inside the chain container, import a key from mnemonic.
docker exec -it <chain-container> <chaind> keys add bridge-admin --recover
# Or from hex:  --interactive --algo eth_secp256k1
```

The keyring entry name (`bridge-admin`) is what you pass to `--from`
below. Verify with:

```bash
docker exec <chain-container> <chaind> keys show bridge-admin
```

**Security note:** all examples below use `--keyring-backend test`,
which stores keys unencrypted inside the container. For any mainnet
key with real value at stake, switch to `--keyring-backend file` or
`--keyring-backend os` — the prompts are slower but the keys are
encrypted on disk.

### Step B.2 — Create Hyperlane state on chain

Three txs in sequence (substitute `<chain-container>` and `<chaind>`
with your chain's container name and binary name):

```bash
# 1) Create the multisig ISM with the initial validator set
docker exec -it <chain-container> <chaind> tx hyperlane ism create \
  --validators "<v1_addr>,<v2_addr>,<v3_addr>" --threshold 2 \
  --from bridge-admin --keyring-backend test --yes -o json | tee /tmp/ism.json
jq -r '.events[] | select(.type=="ism_created") | .attributes[] | select(.key=="ism_id") | .value' /tmp/ism.json
# → 0x<64-hex-chars>

# 2) Create the Mailbox. Positional args: [ism] [domain].
docker exec -it <chain-container> <chaind> tx hyperlane mailbox create \
  <ism_id> <domain> \
  --from bridge-admin --keyring-backend test --yes -o json | tee /tmp/mb.json
jq -r '.events[] | select(.type=="mailbox_created") | .attributes[] | select(.key=="mailbox_id") | .value' /tmp/mb.json

# 3) Create the MerkleTreeHook
docker exec -it <chain-container> <chaind> tx hyperlane hooks merkle create \
  --mailbox <mailbox_id> \
  --from bridge-admin --keyring-backend test --yes -o json | tee /tmp/mh.json
jq -r '.events[] | select(.type=="hook_created") | .attributes[] | select(.key=="hook_id") | .value' /tmp/mh.json

# 4) Wire merkle as BOTH default AND required hook
docker exec -it <chain-container> <chaind> tx hyperlane mailbox set \
  <mailbox_id> \
  --default-hook <merkle_hook_id> \
  --required-hook <merkle_hook_id> \
  --from bridge-admin --keyring-backend test --yes
```

**Gotcha:** both `--default-hook` AND `--required-hook` must point at
the merkle hook. Without `--required-hook`, the merkle root never
advances and validators sign stale leaves.

### Step B.3 — Validator announce (per validator)

Cosmos chains running Ethermint **revert on
`ValidatorAnnounce.announce` self-calls** (the auto-announce path that
EVM-only chains use), so each validator's announce is a manual
two-hop:

**On the validator's host:** export sig (their key never leaves their
machine).

**On the deployer's host:** wrap the sig into a Cosmos tx and submit
via the chain's keyring.

(See `tools/cosmos_announce.mjs` in your bridge's own repo for the
helper script; the upstream kit ships an EVM-focused happy path.)

### Step B.4 — Verify on chain

```bash
docker exec <chain-container> <chaind> query hyperlane mailbox show <mailbox_id>
docker exec <chain-container> <chaind> query hyperlane ism show <ism_id>
```

The `validators` array in the ISM output should list every announced
address.

---

## Step 6 (both paths) — Register the chain in `chains/<key>/`

> **If Hyperlane core is already deployed** on the new chain (e.g.,
> someone else ran it before the kit existed, or another bridge
> already uses the same Mailbox), skip Steps A.1 / B.2 and start
> here — Step 6 just registers a chain.yaml preset against
> already-on-chain addresses. Read `mailbox`, `merkleTreeHook`,
> `validatorAnnounce`, and `ismFactory` off chain (block explorer
> or `cast call Mailbox.merkleTreeHook()` etc.) and paste them
> below.

Copy the template and fill in real values:

```bash
cd <kit-root>
cp -r chains/_template chains/<new-key>
$EDITOR chains/<new-key>/chain.yaml
```

Fill in:
- `key:` — `<new-key>` (must match the directory name)
- `chainId:` / `domain:` — both numeric (usually equal)
- `protocol:` — `ethereum` or `cosmosnative`
- `rpcUrls:` — public-read RPC(s); add 2+ for fallback
- `blockExplorer:`
- `finality.reorgPeriod:` — depth in blocks before validators sign
- `native:` — `symbol`, `decimals`
- `hyperlane:` — `mailbox`, `merkleTreeHook`, `validatorAnnounce`,
  `ismFactory` (from step A.1 / step B.2 outputs)
- `index.from:` — the block of the mailbox-create tx. Saves a 100×
  backfill on fresh chains.
- (Optional) `transactionOverrides.gasPrice:` — string, only if the
  chain has a flat-fee gas model.

Commit + push the new `chains/<new-key>/` directory.

---

## Step 7 — Every operator: pull + extend

```bash
git pull

# Validator operators:
cd chains/<new-key>/validator
cp .env.example .env
# copy your existing VALIDATOR_KEY + bucket creds from another chain's .env
./drive.sh up -d

# Relayer operators:
cd relayer
# extend RELAY_CHAINS in .env (or leave blank to auto-include every preset)
bash 01_setup.sh        # generates new SIGNER_KEY_<NEW>=
# fund the new signer (see 02_fund_keys.md)
./drive.sh restart
```

After restart:
- Each validator's `./drive.sh logs -f` should show backfill from
  `index.from` to chain tip, then steady-state signing.
- Relayer's `./drive.sh status` should list the new chain under
  `chains:` with `pending: 0` once backfill completes.

---

## Step 8 — Deploy the first warp router pair

Hand off to **`ADD_TOKEN.md`** to deploy the first asset on the
new chain (most natural: the chain's native token bridged to another
chain). Run that runbook end-to-end before continuing here.

---

## Step 9 — Smoke verify

After `ADD_TOKEN.md` deploys at least one router pair:

```bash
cd <kit-root>/recovery
node verify_bridge_health.mjs --chain <new-key>
```

Should report every declared address as on-chain-present + correctly
wired.

Then do a real bidirectional test transfer (see `ADD_TOKEN.md`).

---

## Rollback

The new chain's contracts are isolated — no value is at stake until
`ADD_TOKEN.md` deploys warp routers. If something is wrong:

- Delete `chains/<new-key>/` from the kit.
- Each operator removes the local checkout: `rm -rf chains/<new-key>/`
  + the relayer drops the chain from `RELAY_CHAINS`.
- The deployed Hyperlane core just sits there — redeploy after fixing.

If you got as far as deploying warp routers (`ADD_TOKEN.md`):

- Don't try to "delete" them. Just unenroll the remote router on each
  side: `router.enrollRemoteRouter(domain, 0x0000...)`. Funds locked
  in collateral routers can be recovered by the owner using
  `router.transferOwnership` + a recovery contract — out of scope here.

---

## What NOT to do

- **Don't deploy a new ISM without the validators ready.** A Mailbox
  with an ISM containing not-yet-running validators produces
  undeliverable messages — every send becomes a stuck message.
- **Don't pick a `domain` that collides** with another Hyperlane chain
  in the broader ecosystem. Using `chainId` for both fields avoids
  this for any non-trivial chain.
- **Don't share Mailbox or ISM addresses between chains.** Each chain
  has its own `Mailbox` instance.
- **Don't use `--keyring-backend test` for mainnet admin keys** — see
  the security note in Path B.
