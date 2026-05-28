<!--
Thanks for opening a PR! Pick the closest section and fill in the
checklist. CI runs on every PR and verifies on-chain addresses match
what's declared.
-->

## What this PR does

<!-- One-line summary. e.g. "Add chains/arbitrum/ — Hyperlane core deployed at <tx_hash>." -->

## Type

- [ ] Add a chain (`chains/<key>/chain.yaml` + scaffold)
- [ ] Add a warp router (token) to an existing chain (updates `shared/addresses.yaml`)
- [ ] Add a validator / relayer entry (updates `shared/addresses.yaml`)
- [ ] Fix or update an existing chain preset
- [ ] Framework change (scripts, runbooks, UI)

---

## Adding a chain? Tick before requesting review

- [ ] **chain.yaml** is at `chains/<your-key>/chain.yaml`, dir name matches `key:` field
- [ ] **Hyperlane core deployed** — `mailbox`, `merkleTreeHook`, `validatorAnnounce`, `ismFactory` are all real on-chain contracts (not `0x0`)
- [ ] **RPC URLs work** from a fresh machine: `curl -s -X POST <rpc> -d '{"jsonrpc":"2.0","method":"eth_chainId","id":1}'` returns the declared `chainId`
- [ ] **Block explorer URL** loads and is real
- [ ] **`tools/gen_registry.mjs > chains/REGISTRY.md`** has been re-run + committed
- [ ] **Validator scaffold** copied from `chains/_template/validator/` to `chains/<your-key>/validator/`
- [ ] If this chain uses **legacy/flat-fee gas**, `transactionOverrides.gasPrice` is set as a string
- [ ] Initial validator set discussed in the operator channel (the `ism` / `ismValidators` will be populated by `promote_operator.sh` after merge, not in this PR)

## Adding a warp router (token)?

- [ ] Both source + destination routers deployed via `deployer/_run_deploy.sh deploy_warp_router.mjs`
- [ ] Cross-enrolled via `enroll_pair.mjs` — verified both sides see each other
- [ ] Entries added under each chain's `routers:` block in `shared/addresses.yaml`
- [ ] Cross-enrollment pair added under `enrollments:` in `shared/addresses.yaml`
- [ ] Smoke transfer in both directions confirmed (paste tx hashes in PR description)

## CI checks (auto)

- `verify-chains` workflow:
  - All `chain.yaml` files parse + have required fields
  - `build_agent_config.mjs`, `gen_state.mjs` produce valid output
  - `gen_registry.mjs` output matches committed `REGISTRY.md` (no stale registry)
  - `verify_bridge_health.mjs` confirms on-chain state matches declarations (best-effort on RPC availability)

## Reviewer checklist

- [ ] Chain is legit / aligned with the bridge's product direction
- [ ] RPC URL is a reputable provider (not a phishing host that could feed bad block data to validators)
- [ ] Mailbox bytecode matches the canonical Hyperlane v3 build (spot-check via explorer)
- [ ] Initial validator set proposal is reasonable
