# Runbook: Add a Relayer

End-to-end: a new operator clones the kit, generates per-chain signer
keys, funds them, and starts a relayer with the stagger sidecar at a
chosen delay tier. Designed so adding relayer #2, #3, #N is essentially
free in steady state — only the primary pays gas; the rest sit warm.

## Pre-conditions

- [ ] New operator approved for this round.
- [ ] VPS available (4 vCPU / 8 GB / 100 GB SSD recommended).
- [ ] Read access to **every existing validator's bucket URL**
  (those are public, but you need to know the URLs).
  Get them from `shared/addresses.yaml` or the operator channel.

## Why we want multiple relayers

A single relayer is a single point of failure. If it crashes or its
host goes offline, in-flight messages stall until it recovers. With
multiple relayers running independently, any one can deliver — they
all watch the same Mailbox events and the same validator buckets.

The risk of running them naively is **gas wars**: two relayers see the
same message, both submit `process()` at the same time, both pay gas,
only one wins. To avoid that, every relayer here ships with the
**stagger sidecar**, which:

1. Intercepts the relayer agent's `eth_sendRawTransaction` calls.
2. Delays them by `RELAYER_DELAY_MS`.
3. Right before forwarding to the chain RPC, re-checks
   `Mailbox.delivered(messageId)`.
4. If already delivered (someone else won), drops the tx with no gas spent.

So in steady state the primary (delay 0) pays gas; warm spares (15s,
30s, 60s, ...) almost never fire. They only fire when the primary
misses.

## Delay tier selection

| Tier | Delay | Steady-state gas | Failover lag |
|---|---|---|---|
| Primary (r1) | 0 s | ~100% of total | n/a |
| Warm spare (r2) | 15 s | ~0% | +15s if r1 dies |
| Cold spare (r3) | 30 s | ~0% | +30s if r1 + r2 both die |
| Extra (r4+) | 60 s, 120 s, ... | ~0% | only catastrophic failure |

A new operator joining typically takes the next-lowest unused tier.
Coordinate in the operator channel so two relayers don't pick the same.

---

## Step 1 — Clone + key gen

```bash
git clone <kit-repo>
cd operator-kit/relayer
cp .env.example .env
```

Edit `.env`:
- `OPERATOR_NAME=` — your label (lowercase + dashes), e.g., `acme-relay`.
- `RELAYER_DELAY_MS=` — your tier (e.g., `15000` for warm spare). Coordinate
  in the operator channel — two relayers at the same tier = gas wars.
- `RELAY_CHAINS=` — comma-separated chain keys this relayer will deliver
  to. Must match keys under `chains/<key>/`. Leave empty to default to
  every preset chain.

Run:

```bash
bash 01_setup.sh
```

This generates **one EVM key per chain in RELAY_CHAINS**. Each key is
isolated — compromise on chain X doesn't expose chain Y. Keys are
written into `.env` as `SIGNER_KEY_<CHAIN_UPPER>=`, e.g.
`SIGNER_KEY_EXAMPLE_MAINNET=`. Public addresses are printed and also
dumped to `02_fund_keys.md`.

---

## Step 2 — Fund the signer keys

```bash
cat 02_fund_keys.md
```

Shows your per-chain signer addresses + a recommended starting balance
per chain. Target enough native gas for **~1,000 deliveries** per chain
(cheap on most L2s; budget more on long-finality L1s).

Funding is manual — send from your own wallet, or ping the operator
channel and someone with chain-side funds will top you up.

The agent will refuse to start delivering to a chain whose signer
balance is 0 and warn when balances drop below 50% of recommended.

---

## Step 3 — Start the relayer

```bash
./drive.sh up -d
```

Brings up two containers:
- `hyperlane-relayer-<OPERATOR_NAME>` — the Hyperlane agent.
- `stagger-sidecar-<OPERATOR_NAME>` — the local proxy enforcing
  `RELAYER_DELAY_MS` and double-checking `Mailbox.delivered()`.

The agent is configured (in `shared/agent-config.json`) to talk to
the sidecar instead of the chain RPC for sending txs. Reads still go
directly to the chain.

---

## Step 4 — Verify

```bash
./drive.sh status
```

Expected output (example with two chains):
```
relayer    : up
sidecar    : up
delay      : 15000 ms
chains     : example-mainnet, example-testnet
pending    : 0   (last 100 messages, all delivered)
revert pct : 0.4%   (race losses — under 5% is healthy)
balances   :
  example-mainnet  - 0.96 NATIVE  OK
  example-testnet  - 0.99 TEST    OK
```

If `pending > 5` AND `revert pct < 1%`, your relayer might not be
seeing the buckets correctly — check `shared/agent-config.json` has
every validator's URL.

If `revert pct > 20%`, your delay tier is too aggressive for your
network conditions — bump `RELAYER_DELAY_MS` by 10–15 seconds.

---

## Step 5 — Stress-test (optional but recommended)

Have the primary relayer operator stop their relayer for 5 minutes.
Watch yours:
- Within `RELAYER_DELAY_MS` of the next dispatched message, your
  sidecar should start submitting `process()` txs.
- `pending` should remain near 0 even though the primary is down.
- Your signer balances drop as you pay gas instead.

Restart the primary. Within minutes your `revert pct` should rise
again (you lose races to it) and balances stop dropping. Your
relayer is now a working warm spare.

---

## Rollback / departure

If you need to step down:

```bash
./drive.sh down
```

That's it. No on-chain action. Other relayers cover. Funds remaining
in your signer keys can be drained to your main wallet using:

```bash
node tools/drain_relayer_keys.mjs  # sends all per-chain balances to a single address
```

## What you DON'T have to do

- You don't need permission from the deployer, the validators, or any
  multisig. The Mailbox is permissionless. Relayer success or failure
  doesn't change ISM state, doesn't change router state, doesn't change
  validators. It only determines whether `process()` lands.
- You don't see message contents. The Mailbox is content-agnostic.
- You can't double-spend. `Mailbox.delivered(messageId)` short-circuits.
- You don't have to coordinate handoffs when joining or leaving. Hot-swap.
