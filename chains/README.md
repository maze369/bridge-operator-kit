# Validator Quickstart

End-to-end walkthrough for joining the bridge as a validator, starting
from a fresh Ubuntu server. Should take ~30 minutes of focused work.

By the end you'll have:
- A validator agent running 24/7 watching one or more chains
- A public-read bucket where it publishes signed checkpoints
- Your validator address ready to share with the bridge admin for
  inclusion in the active ISM

> **What is a validator?** It signs the source-chain merkle root every
> few seconds. Other validators do the same. When enough independent
> signatures accumulate on a message, the bridge delivers it. Hyperlane
> has no slashing — your reputation is your stake.

---

## What you need

| Thing | Minimum | Why |
|---|---|---|
| Linux server | Ubuntu 22.04+ or Debian 12+ | Docker host |
| CPU / RAM / disk | 2 vCPU / 4 GB / 20 GB SSD | Agent is light, but each chain you watch adds ~200 MB RAM + ~1 GB disk |
| Sudo access | Yes | To install Docker |
| 24/7 uptime | Yes | If you drop offline, you lag the chain and get removed from the ISM |
| Cloudflare account | Free tier OK | For the R2 bucket that hosts your sigs (or skip if using localStorage on a single host) |
| Native gas | A small amount of the chain's native token | To announce your validator address on-chain (one-time, ~$0.01 worth) |

---

## Step 1 — SSH into your server

From your laptop:

```bash
ssh ubuntu@your-server-ip
```

You should see the Ubuntu welcome message. Stay logged in for the rest of these steps.

---

## Step 2 — Install Docker

The kit runs everything through Docker Compose. Most servers don't have it pre-installed.

```bash
# Update apt
sudo apt-get update

# Install Docker via the official script (~30 seconds)
curl -fsSL https://get.docker.com | sudo sh

# Add your user to the docker group so you don't need sudo for every command
sudo usermod -aG docker $USER

# Apply the new group membership without re-logging in
newgrp docker
```

Verify:

```bash
docker version
docker compose version
```

Both should print version numbers. If `docker compose version` says "command not found", the install was incomplete — re-run the curl line above.

---

## Step 3 — Install git (if not already)

```bash
sudo apt-get install -y git
git --version
```

---

## Step 4 — Clone the kit

```bash
cd ~
git clone https://github.com/maze369/bridge-operator-kit.git
cd bridge-operator-kit
```

Look around:

```bash
ls chains/
```

You should see each supported chain as a directory (`qom`, `creative`, etc.), plus a `_template` (blueprint, ignore) and a `REGISTRY.md` (list of all supported chains).

---

## Step 5 — Set up your signature storage bucket

Validators sign and publish checkpoints to a public-read storage backend.
The relayer on the bridge's host fetches from there to assemble multisig
proofs. Two options:

### Option A — Cloudflare R2 (recommended for any cross-host setup)

If your server is different from the bridge's relayer host (it usually is),
you **must** use HTTP-readable storage. R2's free tier covers a year of
validator uptime in storage + bandwidth.

1. Go to <https://dash.cloudflare.com> → R2 → Create bucket
   - Name suggestion: `bridge-sigs-<your-handle>`
   - Region: any low-latency region
2. Open the bucket → Settings → enable "Allow public access" with policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::bridge-sigs-YOURNAME/*"}]
   }
   ```
3. R2 → Manage R2 API Tokens → Create API Token → Object Read & Write,
   scoped to your bucket. Save the **Access Key ID** + **Secret Access Key**.
4. Note your **Account ID** (top-right of the R2 dashboard) — you'll need
   it for the endpoint URL: `https://<account-id>.r2.cloudflarestorage.com`
5. Find your **public URL** under bucket → Settings → Public R2.dev URL.
   It looks like `https://pub-<random>.r2.dev/`.

### Option B — localStorage (only if validator + relayer share a host)

If you happen to be on the same host as the bridge's relayer (uncommon —
ask the admin), you can use a bind-mounted local directory at
`/srv/hyperlane-sigs/`. No bucket setup, but only works in this narrow
scenario.

---

## Step 6 — Pick a chain to watch

Each chain has its own directory under `chains/`. Run a validator agent
for each chain you want to support. Start with one; you can add more
later. For most bridges, watching every chain is the standard pattern.

```bash
cd ~/bridge-operator-kit/chains/creative/validator   # or qom, or whatever
```

---

## Step 7 — Configure your operator identity + bucket

```bash
cp .env.example .env
nano .env       # or vim, or your editor
```

Set these fields:

```env
# Lowercase, dashes only. Used in container names + the on-chain relayer roster.
OPERATOR_NAME=your-handle

# Pick: s3 (with R2/S3 creds below) or localStorage (single-host pilots only)
CHECKPOINT_SYNCER_TYPE=s3

# Your bucket's PUBLIC URL (Option A step 5)
BUCKET_URL=https://pub-XXXXXXXXXXXX.r2.dev

# R2 / S3 fields — fill if CHECKPOINT_SYNCER_TYPE=s3
CHECKPOINT_SYNCER_BUCKET=bridge-sigs-your-handle
CHECKPOINT_SYNCER_REGION=auto
CHECKPOINT_SYNCER_ACCESS_KEY=...           # from R2 API Token
CHECKPOINT_SYNCER_SECRET_KEY=...           # from R2 API Token
CHECKPOINT_SYNCER_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
```

Leave `VALIDATOR_KEY=` empty — the next step fills it.

Save + exit.

---

## Step 8 — Generate your validator signing key

```bash
bash 01_setup.sh
```

This generates a fresh EVM keypair locally (no network call), writes the
private key into `.env`, prints the public address. **Save the public
address** — the admin needs it to add you to the ISM.

The script also creates `02_announce.md` with the exact one-line command
the admin will run.

> **The validator key never moves value.** It signs Merkle checkpoints
> off-chain and pays gas for one announce tx per chain. Treat it like
> a server-deployment key, not a user wallet.

---

## Step 9 — Fund the validator address with native gas

The first time your agent boots on a chain, it self-announces by calling
`ValidatorAnnounce.announce(...)`. That tx costs a tiny amount of native
gas. Send a small amount (~$0.01 worth) of the chain's native asset to
the address from Step 8.

For example on the chain you picked, find the chain's native symbol in
`../chain.yaml` under `native.symbol:`, then send some of it to your
validator address from any wallet you control.

---

## Step 10 — Start the validator

```bash
./drive.sh up -d
```

What happens:
1. Builds + starts a container named `bridge-validator-<chain>-<your-handle>`
2. On first boot, the agent self-announces on-chain (~50k gas tx)
3. Then it backfills the chain's merkle tree from the chain's deploy
   block to current head (5-15 min depending on chain)
4. Starts signing every new merkle root and writing sigs to your bucket

Tail the logs to watch progress:

```bash
./drive.sh logs -f
```

Look for `signing checkpoint, index: NNN` lines that increment over time.
Press Ctrl+C to detach from logs — the container keeps running.

> **Note — validators sign forward-only.** A freshly-started validator
> doesn't backfill *signatures* for past checkpoints. It catches up the
> merkle tree to the chain head and then signs every new checkpoint from
> that moment onward. If you join an active bridge, your first sigs land
> as new bridge messages flow through — until someone bridges, your
> sigs directory will only contain `announcement.json` and
> `metadata_latest.json`. That's normal.

---

## Step 11 — Tell the admin

Post in the bridge's operator channel:

```
Validator address: 0x...........            ← from Step 8
Bucket URL:        https://pub-XXXX.r2.dev  ← from .env BUCKET_URL
Chains watched:    creative                 ← which directories you set up
```

The admin runs **one command** that adds you to the active multisig ISM
and swaps the bridge's warp routers to use the new ISM. Bridge keeps
operating uninterrupted.

---

## Step 12 — Verify you're live

After the admin confirms they ran the `add-validator` step:

```bash
# Pull the latest addresses
cd ~/bridge-operator-kit
git pull

# Run the verifier (no key needed, anyone can do this)
cd recovery && npm install --silent && node verify_bridge_health.mjs --verbose | grep -E 'ISM|validators'
```

You should see your address in the "validators" list under each chain
that watches the chain you set up.

Or use the bridge's frontend — the signer count goes up by one on the
next page load.

---

## Step 13 — (Optional) Watch additional chains

Repeat Steps 6–11 in each additional chain's directory:

```bash
cd ~/bridge-operator-kit/chains/qom/validator
cp .env.example .env
# In the new .env:
#   - OPERATOR_NAME=your-handle    (SAME as your first chain — one identity)
#   - VALIDATOR_KEY=0x...          (SAME hex value from first chain's .env)
#   - CHECKPOINT_SYNCER_TYPE=...   (same as first chain)
#   - bucket creds                 (same bucket if Option A — sigs go in a
#                                   per-chain subdir under the operator
#                                   prefix automatically)
./drive.sh up -d
```

**Reuse the same OPERATOR_NAME *and* VALIDATOR_KEY across every chain
you watch.** One identity per operator across the whole bridge keeps ISM
management simple — the admin adds one address to every chain's ISM
instead of one address per (operator, chain) pair.

---

## Common errors

| Error | Fix |
|---|---|
| `bash 01_setup.sh` → `ERROR: need either host node + ethers, or docker` | Docker isn't installed. Go back to Step 2. |
| `Permission denied` running docker | Forgot `newgrp docker` after `usermod -aG docker`. Either run `newgrp docker` once, or log out and back in. |
| Validator logs say `tokens_needed: N — Please send tokens to your chain signer address` | You skipped Step 9. Send native gas to your validator address. |
| Validator backfill seems stuck | Backfill from `index.from` in the chain's `chain.yaml` can take 5-15 min on first boot. If still stuck after 30 min, check network connectivity to the chain's RPC: `curl -sf -X POST <chain's first RPC> -d '{"jsonrpc":"2.0","method":"eth_blockNumber","id":1}'` |
| `./drive.sh up` exits with no .env | Did you forget `cp .env.example .env`? |
| Validator crash-loops with `Provided config path via CONFIG_FILES is not a file ("/config/agent-config.json")` | Old drive.sh versions could leave `shared/agent-config.json` as a directory if the first run tried to start the agent before `tools/node_modules` was installed. Fix: `./drive.sh down`, then `sudo rm -rf <kit-root>/shared/agent-config.json`, then `drive.sh up -d` — the current drive.sh installs tools deps automatically before building the config. |

---

## Lifecycle

| Action | Command |
|---|---|
| Stop agent | `./drive.sh down` |
| Restart agent | `./drive.sh restart` |
| Tail logs | `./drive.sh logs -f` |
| Container status | `./drive.sh ps` |
| Update kit version | `cd ~/bridge-operator-kit && git pull`, then `./drive.sh restart` in each chain dir |

---

## How to add a brand-new chain to the bridge

This is a different runbook than running a validator — it's for adding a
chain to the supported set. See [`../runbooks/ADD_CHAIN.md`](../runbooks/ADD_CHAIN.md).

## How the directory structure works

Each `chains/<key>/` is a chain preset — the chain's facts (RPCs, mailbox
address, gas overrides) live in `chain.yaml`, and the validator scaffold
is in `validator/`. The `_template/` directory is the blueprint you'd
copy if you were proposing a new chain via PR. See
[`REGISTRY.md`](./REGISTRY.md) for the current list.
