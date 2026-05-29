# Runbook: Add a Validator

End-to-end: a new operator clones the kit, generates a key, runs the
agent for one or more chains, and gets added to the active ISM. Targets
~1 hour of operator time on the new-operator side and ~5 minutes from
the admin side.

## Pre-conditions

- [ ] The new validator has been approved (a social decision, not a
  technical gate).
- [ ] The operator has a VPS (2 vCPU / 4 GB / 40 GB SSD) with Docker
  installed, and a Cloudflare R2 / AWS S3 bucket with public-read
  access (or a same-host setup using `localStorage`).
- [ ] An admin (current ISM owner — operator key, Safe signer, or
  Governor proposer, depending on phase) can run
  `tools/promote_operator.sh add-validator …`.

## Roles in this runbook

| Role | Who | What they do |
|---|---|---|
| **New operator** | the person being onboarded | runs steps 1–4 + 6 on their own VPS |
| **Admin** | current ISM/router owner | runs step 5 (the on-chain change) |

---

## Step 1 — New operator: clone + key gen

```bash
git clone <kit-repo>
cd operator-kit
```

Pick your first chain — the chain key matches a directory under
`chains/`. The kit ships `chains/_template/` (blueprint, don't run)
and example presets `chains/example-mainnet/`, `chains/example-testnet/`.
Real deployments add presets like `chains/<your-chain>/`.

```bash
cd chains/<chain-key>/validator
cp .env.example .env
```

Edit `.env`:
- `OPERATOR_NAME=` — your short label (lowercase + dashes), e.g.,
  `alice` or `acme-labs`. Used in container names + status output.
- Leave `VALIDATOR_KEY=` empty — `01_setup.sh` fills it.
- Configure the sig-storage section (S3/R2 or localStorage; see comments).

Generate the validator keypair:

```bash
bash 01_setup.sh
```

This:
- Generates an EVM keypair locally (no network call).
- Writes the **private key** into `.env` as `VALIDATOR_KEY=`.
- Prints the **public address** + a stub `02_announce.md` with the
  exact line for the admin to run.
- Refuses to overwrite an existing key. If you re-run, your old key
  is safe.

**The validator key never sends value-bearing txs.** It signs only
Hyperlane Merkle checkpoints (off-chain) and one announce tx per chain
(paid in native gas). Treat it like a server-deployment key, not a
user wallet.

---

## Step 2 — New operator: public sig bucket (or localStorage)

The validator agent writes signed checkpoints to a public-read object
store; relayers pull from it. Bucket must be publicly readable; writes
are with your own credentials.

For Cloudflare R2 (recommended — free tier covers expected volume):
1. Create bucket at dash.cloudflare.com → R2.
2. Set bucket policy to public-read on `/<chain-key>/*` and `/announcement.json`.
3. Create an API token scoped to this bucket with Object Read+Write.
4. Fill the `CHECKPOINT_SYNCER_*` fields + `BUCKET_URL=` in your `.env`.

For single-box pilots (validator + relayer on the same host),
`CHECKPOINT_SYNCER_TYPE=localStorage` works — sigs land under
`/srv/hyperlane-sigs/<operator>/<chain>/` and the relayer reads them
via bind-mount.

Verify with:

```bash
curl -sI ${BUCKET_URL}/announcement.json
# Expect 404 (no announcement yet — that's step 4) but NOT 403
```

---

## Step 3 — New operator: fund the validator address

The first time the agent boots on a chain it self-announces via
`ValidatorAnnounce.announce(...)`. Fund the validator address (from
step 1) with a tiny amount of native gas on every chain you'll run
validators for. A few cents' worth is enough for several years of
re-announce events.

---

## Step 4 — New operator: start the agent

```bash
./drive.sh up -d
```

`drive.sh` reads `../chain.yaml`, rebuilds `shared/agent-config.json`
from every preset's `chain.yaml`, and brings up a validator container
named `bridge-validator-<chain>-<operator>`. The first boot:

- Self-announces on `ValidatorAnnounce` (1 tx, ~50k gas).
- Backfills from `index.from` to chain tip.
- Starts writing signed checkpoints to your bucket every signed index.

Backfill speed depends on the chain — fresh chains finish in seconds,
mature chains can take 5–15 minutes. Watch:

```bash
./drive.sh logs -f
```

Look for `signing checkpoint, index: NNN` lines incrementing
~every few seconds.

To run validators for additional chains, repeat steps 1–4 in each
`chains/<other-key>/validator/` directory. Reuse the same
`VALIDATOR_KEY=` across all chains — one validator identity per
operator across the whole bridge keeps ISM management simple.

```bash
cd ../../<other-chain>/validator
cp .env.example .env
# copy VALIDATOR_KEY + bucket creds from the first chain
./drive.sh up -d
```

**Notify the admin:** share with them:
- Your validator address (from step 1)
- Your bucket URL (or localStorage path)
- The chain keys you've successfully announced on
- Confirmation that `./drive.sh logs` shows signing in steady state

---

## Step 5 — Admin: add to the ISM

The admin runs:

```bash
cd <kit-root>
DEPLOYER_KEY_FILE=/path/to/admin.key \
THRESHOLD=N \
bash tools/promote_operator.sh add-validator <new-validator-addr>
```

> **Per-chain owner keys.** If the bridge has different EOA owners on
> different chains (common when chains were deployed at different
> times by different people), set `DEPLOYER_KEY_<CHAIN_UPPER>_FILE`
> for each chain that needs a non-default key. The runner forwards
> each as `HYP_KEY_<CHAIN>` to the deploy container and
> `update_ism.mjs` picks the per-chain key when present, falling
> back to the default `DEPLOYER_KEY` otherwise. Example for a bridge
> whose Creative routers are owned by a separate EOA:
>
> ```bash
> DEPLOYER_KEY_FILE=/path/to/default-admin.key \
> DEPLOYER_KEY_CREATIVE_FILE=/path/to/creative-admin.key \
> THRESHOLD=2 \
> bash tools/promote_operator.sh add-validator <addr>
> ```

`promote_operator.sh` auto-detects which authorization mode the bridge
is in by reading `router.owner()`:

| Mode | What happens |
|---|---|
| Phase 1 (EOA) | Broadcasts: new ISM via factory + `setInterchainSecurityModule(newIsm)` on every warp router. |
| Phase 2 (Safe) | Emits Safe Transaction Builder JSON files for signers to review + co-sign. |
| Phase 3 (Governor) | Emits an OZ Governor proposal payload. |

The on-chain effect is the same in every mode: deploy a new
`StaticMessageIdMultisigIsm` containing the expanded validator set
and swap the warp routers to it. Hyperlane's CREATE2 factory means
`(validators, threshold)` is deterministic — re-running with the same
set is a no-op.

`promote_operator.sh` also updates `shared/addresses.yaml` with the
new ISM address + validator set and regenerates `shared/state.json`
(for the bridge UI).

Bridge UX is uninterrupted. New messages dispatched after the ISM
swap verify under the new set; in-flight messages already in-process
still verify against the old ISM until they finalize.

---

## Step 6 — New operator: verify inclusion

```bash
cd recovery && node verify_bridge_health.mjs
```

This reads `shared/addresses.yaml` + each chain's RPC, calls each
ISM's `validators()` / `validatorsAndThreshold()`, and reports the
on-chain state vs the declared set. Your address should be in the
on-chain `validators()` list.

Or check directly on a block explorer: read each chain's warp router's
`interchainSecurityModule()`, then read the ISM's
`validatorsAndThreshold(bytes)`.

The bridge UI's signers indicator will reflect the new count on next
page load (within ~30s of cache TTL).

---

## Rollback if something goes wrong

If the new validator misbehaves (silent, lagging, bad sigs):

```bash
# Admin removes them — emits the inverse payload (new ISM without addr).
bash tools/promote_operator.sh remove-validator <addr>

# New operator stops their agent:
cd chains/<chain>/validator && ./drive.sh down
```

The on-chain `ValidatorAnnounce` for the address is permanent (you
can't un-announce), but a validator not in the active ISM is harmless
— its signatures are just ignored.

---

## Drift recovery — `promote_operator.sh sync`

`add-validator` and `remove-validator` iterate every router listed
under `chains.<k>.routers` in `shared/addresses.yaml` and swap each to
the new ISM. If a router was deployed on-chain but never registered in
the yaml (e.g. an early drill, a hand-rolled deploy, an
`ADD_TOKEN` flow where Step 6 was skipped), it's invisible to the
add/remove flow and its ISM stays pointed at whatever validator set
was active when it was deployed. When that validator later retires,
the orphan router silently stops verifying messages.

To recover from this kind of drift:

1. Discover the orphan router and underlying — read
   `router.interchainSecurityModule()` and `router.wrappedToken()` (or
   `router.underlying()`) off chain.
2. Register it in the yaml: `node tools/yaml_promote.mjs add-router
   <chain> <symbol> <kind> <router-addr> [underlying-addr]`.
3. Run `bash tools/promote_operator.sh sync`. This re-runs
   `update_ism.mjs` with the current `ismValidators` + `ismThreshold`
   from `addresses.yaml`, deploys the target ISM if it's missing
   (CREATE2-deterministic — no-op if already on chain), and swaps any
   router whose `interchainSecurityModule()` doesn't match the
   chain's declared `ism`.

`sync` is idempotent — safe to run any time. It's a useful sanity
check after a multi-chain rotation, or whenever you suspect the
on-chain state has diverged from the yaml.

> **Trust order.** `update_ism.mjs` treats
> `chains.<k>.ism` in `addresses.yaml` as the canonical target. If the
> yaml's `ism` is non-zero and has bytecode on chain, that address is
> used directly — no fresh CREATE2 deploy. Set
> `FORCE_REDEPLOY_ISM=1` to override (e.g. when actually rotating the
> validator set, not just reconciling).

---

## What "live" means before the admin adds you

Between step 4 (agent running) and step 5 (admin adds you to the ISM),
your validator is signing checkpoints and uploading them — but no
relayer's ISM accepts your signatures yet. That's fine: nothing breaks,
your sigs just sit in your bucket unused. The transition in step 5 is
instantaneous from the validator's side — no agent restart needed.
