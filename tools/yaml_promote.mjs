#!/usr/bin/env node
// yaml_promote.mjs — phase-aware addresses.yaml mutator.
//
// Used by deployer/promote_operator.sh to edit shared/addresses.yaml
// without losing comments or reordering fields (uses the `yaml` lib's
// document API). Pure idempotent: re-running with the same args is a no-op.
//
// Commands:
//   add-validator <addr> [...]
//       Appends addr(s) to every chain's `ismValidators` list (dedup,
//       case-insensitive). Does NOT touch the on-chain ISM — that's
//       update_ism.mjs's job. Returns the new validator set per chain
//       on stdout for the caller to feed into update_ism.
//
//   set-ism <chain> <ism_address>
//       Writes the new ISM address into `chains.<chain>.ism` — called
//       after update_ism.mjs deploys the new CREATE2 instance.
//
//   set-threshold <threshold>
//       Updates `ismThreshold` on every chain.
//
//   add-relayer <name> <role> <delayMs> <chain1=addr1,chain2=addr2,...>
//       Appends a new entry to the top-level `relayers:` list.
//
//   remove-validator <addr>
//   remove-relayer <name>
//
//   show                 — pretty-prints current state for human review
//
// Reads/writes ../shared/addresses.yaml relative to script dir.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument, Scalar } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADDR_YAML = path.resolve(__dirname, '..', 'shared', 'addresses.yaml');

function load() {
  return parseDocument(fs.readFileSync(ADDR_YAML, 'utf8'), {
    keepSourceTokens: true,
  });
}
function save(doc) {
  fs.writeFileSync(ADDR_YAML, doc.toString({
    lineWidth: 0,        // preserve long single-line strings
    nullStr: '',         // empty string for null
    blockQuote: 'literal',
  }));
}

function lc(s) { return (s || '').toString().toLowerCase(); }

function addValidator(addr) {
  const doc = load();
  const chains = doc.get('chains');
  if (!chains) throw new Error('addresses.yaml has no `chains` block');
  const changed = [];
  for (const item of chains.items) {
    const chainKey = item.key.value;
    const chCfg = item.value;
    let list = chCfg.get('ismValidators');
    if (!list) continue;  // skip chains without an ismValidators block
    const cur = list.items.map(x => lc(x.value));
    if (!cur.includes(lc(addr))) {
      // pass the string directly; yaml.YAMLSeq creates the proper scalar node.
      list.add(addr);
      changed.push(chainKey);
    }
  }
  if (changed.length) save(doc);
  return changed;
}

function removeValidator(addr) {
  const doc = load();
  const chains = doc.get('chains');
  const changed = [];
  for (const item of chains.items) {
    const chainKey = item.key.value;
    const list = item.value.get('ismValidators');
    if (!list) continue;
    const idx = list.items.findIndex(x => lc(x.value) === lc(addr));
    if (idx >= 0) {
      list.items.splice(idx, 1);
      changed.push(chainKey);
    }
  }
  if (changed.length) save(doc);
  return changed;
}

function setIsm(chain, ism) {
  const doc = load();
  const chCfg = doc.getIn(['chains', chain]);
  if (!chCfg) throw new Error(`chain ${chain} not in addresses.yaml`);
  chCfg.set('ism', ism);
  save(doc);
}

function setThreshold(thr) {
  const doc = load();
  const chains = doc.get('chains');
  const changed = [];
  for (const item of chains.items) {
    const list = item.value.get('ismValidators');
    if (!list) continue;
    item.value.set('ismThreshold', parseInt(thr, 10));
    changed.push(item.key.value);
  }
  if (changed.length) save(doc);
  return changed;
}

function addRelayer(name, role, delayMs, signersStr) {
  const doc = load();
  let relayers = doc.get('relayers');
  if (!relayers) {
    // initialize empty list at top level
    doc.set('relayers', []);
    relayers = doc.get('relayers');
  }
  // Don't re-add if name already present
  for (const item of relayers.items || []) {
    if (item.get('operator') === name) {
      return { changed: false, reason: 'operator already registered' };
    }
  }
  const signers = {};
  for (const pair of signersStr.split(',')) {
    const [k, v] = pair.split('=').map(s => s.trim());
    if (!k || !v) throw new Error(`bad signer pair "${pair}"`);
    signers[k] = v;
  }
  relayers.add({
    operator: name,
    role: role || 'unspecified',
    delayMs: parseInt(delayMs, 10),
    signers,
  });
  save(doc);
  return { changed: true };
}

function removeRelayer(name) {
  const doc = load();
  const relayers = doc.get('relayers');
  if (!relayers) return { changed: false };
  const idx = relayers.items.findIndex(it => it.get('operator') === name);
  if (idx < 0) return { changed: false };
  relayers.items.splice(idx, 1);
  save(doc);
  return { changed: true };
}

function show() {
  const doc = load();
  const chains = doc.get('chains');
  const out = { chains: {}, relayers: [] };
  for (const item of chains.items) {
    const k = item.key.value;
    const c = item.value;
    out.chains[k] = {
      ism: c.get('ism'),
      ismThreshold: c.get('ismThreshold'),
      ismValidators: (c.get('ismValidators')?.items || []).map(x => x.value),
      routers: Object.keys(c.get('routers')?.toJSON() || {}),
    };
  }
  const relayers = doc.get('relayers');
  if (relayers) {
    for (const item of relayers.items) {
      out.relayers.push({
        operator: item.get('operator'),
        role: item.get('role'),
        delayMs: item.get('delayMs'),
        signers: item.get('signers')?.toJSON() || {},
      });
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  switch (cmd) {
    case 'add-validator': {
      const changed = addValidator(rest[0]);
      console.log(JSON.stringify({ changed }));
      break;
    }
    case 'remove-validator': {
      const changed = removeValidator(rest[0]);
      console.log(JSON.stringify({ changed }));
      break;
    }
    case 'set-ism': {
      setIsm(rest[0], rest[1]);
      console.log(JSON.stringify({ ok: true }));
      break;
    }
    case 'set-threshold': {
      const changed = setThreshold(rest[0]);
      console.log(JSON.stringify({ changed }));
      break;
    }
    case 'add-relayer': {
      const res = addRelayer(rest[0], rest[1], rest[2], rest[3]);
      console.log(JSON.stringify(res));
      break;
    }
    case 'remove-relayer': {
      const res = removeRelayer(rest[0]);
      console.log(JSON.stringify(res));
      break;
    }
    case 'show':
      show();
      break;
    default:
      console.error(`unknown command: ${cmd}`);
      console.error(`usage:
  yaml_promote.mjs add-validator <addr>
  yaml_promote.mjs remove-validator <addr>
  yaml_promote.mjs set-ism <chain> <addr>
  yaml_promote.mjs set-threshold <n>
  yaml_promote.mjs add-relayer <name> <role> <delayMs> "chain=addr,..."
  yaml_promote.mjs remove-relayer <name>
  yaml_promote.mjs show`);
      process.exit(2);
  }
} catch (e) {
  console.error('ERR', e?.message || e);
  process.exit(1);
}
