# Relayer Operator Kit

Run a Hyperlane relayer that submits `process()` txs on every destination chain.

## What you sign up for

- **A VPS up 24/7** (4 vCPU, 8 GB RAM, 100 GB SSD — $30-80/mo)
- **Funded keys on every destination chain** (native gas — the relayer spends to deliver)
- **Read access to every validator's public sig bucket** (just URLs, no creds needed — they're public)

You DON'T need permission from anyone to run a relayer. The Mailbox is permissionless.

## Prerequisites on the VPS

| Tool | Version | Used for |
|------|---------|----------|
| Node.js | ≥ 20 | `01_setup.sh` (signer key gen) |
| Docker + `docker compose` plugin | recent | running the relayer + stagger sidecar |
| `bash`, `sudo` | any | scripts |
| `npm` | ships with Node | one-time `npm install` in `relayer/` |

## Multi-relayer safety

You're not alone — at least 2 other relayers run alongside you. Race-condition handling is built in via the **stagger sidecar**: each relayer waits a configured delay before submitting a tx, then re-checks `Mailbox.delivered(mid)` first. In steady state only the lowest-delay (primary) relayer pays gas; the rest are warm spares that take over on failure.

| Your role | Delay | Cost in steady state | Failover lag |
|-----------|-------|----------------------|--------------|
| Primary (#1) | 0 s | ~100% of gas | n/a |
| Warm spare (#2) | 15 s | ~0% of gas | +15 s if primary dies |
| Cold spare (#3) | 30 s | ~0% of gas | +30 s if primary + warm both die |
| Extra (#4+) | 60 s, 120 s, ... | ~0% of gas | only fires in catastrophes |

Set `RELAYER_DELAY_MS` in `.env` to your tier.

## Quick start

```bash
git clone <kit-repo>
cd <kit>/services/bridge-relayer    # (or operator-kit/relayer pre-Drive-merge)
cp .env.example .env
# edit .env — OPERATOR_NAME, RELAYER_DELAY_MS, list of chains

bash 01_setup.sh           # generates a signer key per destination chain
cat 02_fund_keys.md        # shows the addresses + amounts to fund
# fund each key from any wallet (manual — no automation here)

./drive.sh up -d           # starts relayer + sidecar, tails logs
./drive.sh status          # confirm pending msgs are clearing
```

## Files

| File | What |
|------|------|
| `drive.sh` | Compose wrapper (`up -d`, `down`, `logs -f`, `ps`, `restart`, `exec`, `status`). Matches Drive's service convention. |
| `01_setup.sh` | Generates one EVM key per destination chain (so a key compromise on chain X doesn't expose chain Y). |
| `02_fund_keys.md` | Read-only — shows the addresses + recommended balance per chain. |
| `03_start.sh` | Legacy `docker compose up`. Prefer `./drive.sh up -d`. |
| `status.sh` | Pending msgs count, revert rate, signer balances per chain. Invoked via `./drive.sh status`. |
| `docker-compose.yml` | Relayer + sidecar containers, networked. |
| `stagger-sidecar/` | Sidecar source. Intercepts the relayer's `eth_sendRawTransaction` calls, delays them by `RELAYER_DELAY_MS`, re-checks delivery before forwarding. |
| `.env.example` | Template. |

## Daily operation

- `./drive.sh status` — see pending count + signer balances
- Refill signer keys when balance < 50% of target (warning in status output)
- If `reverted/total > 5%` for an hour, widen your stagger delay (race losses are excessive)

## What can go wrong

| Symptom | Cause | Fix |
|---------|-------|-----|
| Relayer container crashes | Bad `.env` or sig-bucket URL | `./drive.sh logs -f` |
| Pending messages not draining | All your signer keys out of gas | Refill native on the dead chain |
| `ErrorCheckingDeliveryStatus` loop | RPC for one chain returning errors | Add fallback RPCs in `shared/agent-config.json` |
| Revert rate > 20% | Stagger too tight, or competing with a faster relayer | Increase `RELAYER_DELAY_MS` by 10s |
| One chain stuck behind | That chain's RPC indexer slow | Check `agent-config.json` reorgPeriod for that chain |

## What you DON'T have to do

- You don't need permission from the deployer or any validator
- You don't see message contents (Mailbox is content-agnostic)
- You don't lose funds if your relayer goes offline — other relayers pick up
- You can't double-spend — Mailbox.delivered() short-circuits duplicates
