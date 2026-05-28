# Multisig Setup

The bridge's emergency committee + (until Phase 4) the only entity that
can change ISM validators, router ownership, or pause routers.

## Spec

- **Gnosis Safe** deployed on every chain in scope.
- **5 signers**, each held by a distinct human/org. Document who in
  `members.yaml` (public — users should be able to verify signers).
- **Threshold 3 of 5** (tolerates 1 malicious + 1 absent).
- **Same signer set on every chain** (simpler to operate; users see consistency).

## Deployment

For each chain:

1. Visit the Safe app for that chain (or use Safe SDK CLI).
2. Create new Safe — paste in the 5 signer addresses, set threshold = 3.
3. Record the Safe address into `shared/addresses.yaml` under the chain's
   `multisig:` field.
4. Have each signer confirm they can sign on this Safe (a dummy tx of value 0).

No script automates this because:
- Each signer should personally connect their wallet and confirm — automating
  via a hot key defeats the purpose of a multisig.
- The Safe UI does signer setup correctly; rebuilding it in script form
  adds risk for no benefit.

## After deployment

The Safe receives ownership of routers + ISMs via
`deployer/05_transfer_ownership.mjs`. From that point on:

- Anyone proposing a change drafts a Safe tx (use the templates in
  `proposal-templates/`).
- 3 signers approve.
- Safe executes through the Timelock (Phase 2+) or directly (Phase 1).

## Proposal templates

`proposal-templates/*.json` are pre-shaped Safe transaction JSON files for
common operations. Open the file, fill in the `value` / `data` fields with
the specific change, import into the Safe UI, gather signatures.

Templates (TODO — to be filled in once core contracts are deployed):
- `set_validators.json` — update ISM validator set
- `set_threshold.json` — change ISM M-of-N threshold
- `pause_router.json` — emergency pause a warp route
- `add_chain.json` — register a new chain in BridgeRegistry (Phase 2+)
- `transfer_router_owner.json` — handoff a router to a new owner

## Signers register

A `members.yaml` (publicly committed) lists each signer:

```yaml
signers:
  - address: 0x...
    name: Operator A
    role: core dev
    contact: a@example.org
  - address: 0x...
    name: Operator B
    role: external validator
    contact: b@example.org
  # ...
```

This is critical: users verifying the bridge can compare the published
list to the on-chain `Safe.getOwners()`. Drift = red flag.

## Operational hygiene

- Each signer uses a hardware wallet for the Safe key.
- No signer holds a hot key copy of the Safe signing key.
- Safe is invoked through https://app.safe.global (or a known-good fork).
- Signers verify the data they're signing matches the proposal text BEFORE
  approving — never click "confirm" on Safe UI without independently
  decoding the calldata against the proposal template.
