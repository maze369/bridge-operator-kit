# Recovery Kit

Scripts and runbooks for keeping the bridge alive when things go wrong.
The single most important property: **the bridge can be resurrected by
one competent operator** with no permissions or coordination, using only
this folder + public RPCs.

## When to use which

| Situation | Tool |
|-----------|------|
| Verify the bridge is honest (run anytime, anyone) | `verify_bridge_health.mjs` |
| All relayers offline → need to spin up a fresh one | `../relayer/01_setup.sh` → `03_start.sh` (any new operator can do this) |
| Pending message stuck → manually submit `process()` | `manual_process.mjs` (TODO) |
| Validator dead > 24h → multisig removes from ISM | `replace_dead_validator.md` (TODO) |
| Chain RPC dead → add fallback | edit `shared/agent-config.json`, restart agents |
| Contract bug found | `../multisig/proposal-templates/pause_router.json` (TODO) |

## Disaster matrix (mirrors §16.5.4 of decentralization plan)

| Scenario | Solo-operator action | Time |
|----------|----------------------|------|
| All relayers gone | `cd ../relayer && cp .env.example .env && bash 01_setup.sh && bash 03_start.sh` | < 1 hour |
| All validators gone (& multisig alive) | Multisig proposes new validator set; new validators run `validator/` kit | days |
| All validators gone (& multisig also gone) | Bridge halts safely. Users withdraw via burning synthetics while M-of-N remains; once threshold lost, contracts inert. Funds safe but stuck. | n/a (no recovery) |
| Chain X RPC dead | Edit `shared/agent-config.json` → add fallback RPC → `docker compose restart` on each agent | minutes |
| Critical bug found | Committee pause, deploy fix, migrate (see decentralization plan §16.5.4 Scenario E) | days |

## Run me now

```bash
cd recovery
node verify_bridge_health.mjs
```

If it prints `ALL GREEN`, the bridge matches its public claims. If not,
each failed check tells you exactly what's drifted.
