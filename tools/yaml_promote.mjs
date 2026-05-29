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
//   add-chain <key> [--threshold N] [--validators 0x..,0x..]
//       Registers a new chain block. Defaults: threshold = first chain's
//       ismThreshold (or 1); validators = union of existing chains'
//       ismValidators. Static facts (rpcUrls, mailbox, ...) come from
//       chains/<key>/chain.yaml — register that preset first.
//
//   add-router <chain> <symbol> <kind> <address> [underlying]
//       Registers a warp router under chains.<chain>.routers.<symbol>.
//       `kind` is one of HypNative | HypERC20 | HypERC20Collateral | HypXERC20.
//       `underlying` is required for Collateral and xERC20.
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
import { parseDocument, parse as parseYaml, Scalar } from 'yaml';
import { getAddress } from 'ethers';

// EIP-55 checksum-normalize any 0x...40hex address before it gets written
// to addresses.yaml. Without this, an operator can paste a mixed-case
// address copied from a tooling output whose checksum differs from EIP-55
// (we hit this 2026-05-29 — gen_state passed the bad address through to
// state.json, the UI's `new ethers.Contract(addr)` threw "bad checksum",
// and a silent catch{} in the balance widget hid the failure so balances
// just showed zero and bridge clicks reverted). All inputs are normalized.
function cs(a) {
  if (typeof a !== 'string') return a;
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) return a;
  try { return getAddress(a.toLowerCase()); } catch { return a; }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADDR_YAML = path.resolve(__dirname, '..', 'shared', 'addresses.yaml');

function load() {
  return parseDocument(fs.readFileSync(ADDR_YAML, 'utf8'), {
    keepSourceTokens: true,
  });
}
function save(doc) {
  fs.writeFileSync(ADDR_YAML, doc.toString({
    lineWidth: 0,                // preserve long single-line strings
    nullStr: '',                 // empty string for null
    blockQuote: 'literal',
    collectionStyle: 'block',    // never inline flow {...} / [...] for new entries
  }));
}

function lc(s) { return (s || '').toString().toLowerCase(); }

function addValidator(addr) {
  const norm = cs(addr);
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
    if (!cur.includes(lc(norm))) {
      list.add(norm);
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
  chCfg.set('ism', cs(ism));
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
    signers[k] = cs(v);
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

function addChain(chainKey, opts = {}) {
  // Verify the chain.yaml preset exists before allowing registration.
  const presetPath = path.resolve(__dirname, '..', 'chains', chainKey, 'chain.yaml');
  if (!fs.existsSync(presetPath)) {
    throw new Error(`chains/${chainKey}/chain.yaml not found — register the chain preset first (see ADD_CHAIN.md)`);
  }

  const doc = load();
  let chains = doc.get('chains');
  if (!chains) {
    doc.set('chains', {});
    chains = doc.get('chains');
  }
  if (chains.has(chainKey)) {
    return { changed: false, reason: 'chain already registered' };
  }

  // Default threshold from first existing chain or 1.
  let threshold = opts.threshold;
  if (!threshold) {
    threshold = chains.items?.[0]?.value?.get('ismThreshold') || 1;
  }

  // Default validators: union of existing chains.
  let validators = opts.validators || [];
  if (validators.length === 0 && chains.items?.length) {
    const set = new Set();
    for (const it of chains.items) {
      const list = it.value.get('ismValidators');
      if (list?.items) for (const x of list.items) set.add(x.value);
    }
    validators = [...set];
  }

  chains.set(chainKey, {
    // ism gets filled in when update_ism.mjs (or `promote_operator.sh sync`)
    // runs and writes back the deployed CREATE2 address via set-ism.
    ism: '0x0000000000000000000000000000000000000000',
    ismValidators: validators,
    ismThreshold: threshold,
    owner: 'operator-key',
    multisig: '0x0000000000000000000000000000000000000000',
    routers: {},
  });
  save(doc);
  return { changed: true, validators, threshold };
}

function addRouter(chainKey, symbol, kind, address, underlying) {
  const VALID_KINDS = ['HypNative', 'HypERC20', 'HypERC20Collateral', 'HypXERC20'];
  if (!VALID_KINDS.includes(kind)) {
    throw new Error(`unknown router kind "${kind}" — must be one of ${VALID_KINDS.join(', ')}`);
  }
  if ((kind === 'HypERC20Collateral' || kind === 'HypXERC20') && !underlying) {
    throw new Error(`router kind ${kind} requires <underlying> (the ERC20 / xERC20 address)`);
  }

  const doc = load();
  const chCfg = doc.getIn(['chains', chainKey]);
  if (!chCfg) throw new Error(`chain ${chainKey} not in addresses.yaml — run add-chain first`);

  let routers = chCfg.get('routers');
  if (!routers || !routers.items) {
    chCfg.set('routers', {});
    routers = chCfg.get('routers');
  }
  const addrCs = cs(address);
  if (routers.has(symbol)) {
    const existing = routers.getIn([symbol, 'address']);
    if (lc(existing) === lc(addrCs)) {
      return { changed: false, reason: 'router already registered with this address' };
    }
    throw new Error(`router ${chainKey}.${symbol} already registered with a different address (${existing}); not overwriting`);
  }
  const entry = { kind, address: addrCs };
  if (underlying) entry.underlying = cs(underlying);
  routers.set(symbol, entry);
  save(doc);
  return { changed: true };
}

function addEnrollment(srcChain, srcSymbol, dstChain, dstSymbol) {
  const doc = load();
  let enrollments = doc.get('enrollments');
  if (!enrollments) {
    doc.set('enrollments', []);
    enrollments = doc.get('enrollments');
  }
  const src = `${srcChain}:${srcSymbol}`;
  const dst = `${dstChain}:${dstSymbol}`;
  for (const it of enrollments.items || []) {
    if (it.get('source') === src && it.get('dest') === dst) {
      return { changed: false, reason: 'enrollment already recorded' };
    }
  }
  enrollments.add({ source: src, dest: dst });
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
    case 'add-chain': {
      const [chainKey, ...flags] = rest;
      if (!chainKey) throw new Error('add-chain requires <key>');
      const opts = {};
      for (let i = 0; i < flags.length; i++) {
        if (flags[i] === '--threshold') { opts.threshold = parseInt(flags[++i], 10); }
        else if (flags[i] === '--validators') {
          opts.validators = flags[++i].split(',').map(s => s.trim()).filter(Boolean);
        }
      }
      const res = addChain(chainKey, opts);
      console.log(JSON.stringify(res));
      break;
    }
    case 'add-router': {
      const [chainKey, sym, kind, addr, underlying] = rest;
      if (!chainKey || !sym || !kind || !addr) {
        throw new Error('add-router <chain> <symbol> <kind> <address> [underlying]');
      }
      const res = addRouter(chainKey, sym, kind, addr, underlying);
      console.log(JSON.stringify(res));
      break;
    }
    case 'add-enrollment': {
      const [src, dst] = rest;
      if (!src || !dst) throw new Error('add-enrollment <src-chain>:<symbol> <dst-chain>:<symbol>');
      const [sc, ssym] = src.split(':');
      const [dc, dsym] = dst.split(':');
      if (!sc || !ssym || !dc || !dsym) throw new Error('expected <chain>:<symbol> on both sides');
      const res = addEnrollment(sc, ssym, dc, dsym);
      console.log(JSON.stringify(res));
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
  yaml_promote.mjs add-chain <key> [--threshold N] [--validators 0x..,0x..]
  yaml_promote.mjs add-router <chain> <symbol> <kind> <address> [underlying]
  yaml_promote.mjs add-enrollment <src-chain>:<symbol> <dst-chain>:<symbol>
  yaml_promote.mjs add-relayer <name> <role> <delayMs> "chain=addr,..."
  yaml_promote.mjs remove-relayer <name>
  yaml_promote.mjs show`);
      process.exit(2);
  }
} catch (e) {
  console.error('ERR', e?.message || e);
  process.exit(1);
}
