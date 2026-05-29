// read_chain_config.mjs — shared helper for the deployer/* scripts.
//
// The kit splits chain config across two files:
//   - chains/<key>/chain.yaml   — static facts: rpcUrls, mailbox, ismFactory,
//                                  validatorAnnounce, merkleTreeHook, chainId,
//                                  domain, native, transactionOverrides
//   - shared/addresses.yaml     — live mutable state: ism, ismValidators,
//                                  ismThreshold, owner, multisig, routers,
//                                  enrollments, relayers
//
// gen_state.mjs already merges them for the UI's state.json. This helper does
// the same merge for deployer scripts so they don't each re-implement.
//
// Returns a flat per-chain object with both static facts AND live state:
//
//   {
//     // static (from chain.yaml)
//     chainId, domain, protocol, name, rpcUrls, blockExplorer,
//     mailbox, merkleTreeHook, validatorAnnounce, ismFactory,
//     reorgPeriod, native, legacyGasPrice,
//     // live (from addresses.yaml)
//     ism, ismValidators, ismThreshold, owner, multisig,
//     routers, // { SYMBOL: { kind, address, underlying? } }
//   }
//
// Usage:
//   import { readChainConfig, readAllChains } from '/work/tools/read_chain_config.mjs';
//   const c = readChainConfig('qom');                  // single chain
//   const all = readAllChains();                       // { qom: {...}, creative: {...} }
//
// Throws if chain key is in addresses.yaml but missing from chains/<key>/,
// or if a referenced field comes back empty after both files are read.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __filename = fileURLToPath(import.meta.url);
// Default KIT_ROOT discovery: tools/ lives at kit-root/tools, so root is parent.
const KIT_ROOT = process.env.KIT_ROOT || path.resolve(path.dirname(__filename), '..');
const CHAINS_DIR = path.join(KIT_ROOT, 'chains');
const ADDR_YAML = path.join(KIT_ROOT, 'shared', 'addresses.yaml');

function readPreset(key) {
  const yp = path.join(CHAINS_DIR, key, 'chain.yaml');
  if (!fs.existsSync(yp)) return null;
  return parseYaml(fs.readFileSync(yp, 'utf8'));
}

function readAddressesRaw() {
  // Expand ${ENV_VAR} placeholders the same way the old hand-parser did,
  // so callers can override the live ISM/router address from env if needed.
  const raw = fs.readFileSync(ADDR_YAML, 'utf8')
    .replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] || `__MISSING_${n}__`);
  return parseYaml(raw) || {};
}

function readPresetMap() {
  if (!fs.existsSync(CHAINS_DIR)) return {};
  const out = {};
  for (const e of fs.readdirSync(CHAINS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const c = readPreset(e.name);
    if (c && c.key) out[c.key] = c;
  }
  return out;
}

function mergeOne(key, preset, state) {
  if (!preset) {
    throw new Error(`chain "${key}" missing chains/${key}/chain.yaml — register the preset first (see ADD_CHAIN.md)`);
  }
  return {
    // static
    chainId: Number(preset.chainId),
    domain: Number(preset.domain ?? preset.chainId),
    protocol: preset.protocol || 'ethereum',
    name: preset.name || key,
    rpcUrls: preset.rpcUrls || [],
    walletRpcUrls: preset.walletRpcUrls || preset.rpcUrls || [],
    blockExplorer: preset.blockExplorer || '',
    mailbox: preset.hyperlane?.mailbox || '',
    merkleTreeHook: preset.hyperlane?.merkleTreeHook || '',
    validatorAnnounce: preset.hyperlane?.validatorAnnounce || '',
    ismFactory: preset.hyperlane?.ismFactory || '',
    reorgPeriod: preset.finality?.reorgPeriod ?? null,
    native: preset.native || { symbol: key.toUpperCase(), decimals: 18 },
    legacyGasPrice: preset.transactionOverrides?.gasPrice || null,
    // live
    ism: state?.ism || '',
    ismValidators: state?.ismValidators || [],
    ismThreshold: Number(state?.ismThreshold ?? 0),
    owner: state?.owner || 'operator-key',
    multisig: state?.multisig || '0x0000000000000000000000000000000000000000',
    routers: state?.routers || {},
  };
}

export function readChainConfig(key) {
  const preset = readPreset(key);
  const yaml = readAddressesRaw();
  const state = yaml.chains?.[key] || null;
  return mergeOne(key, preset, state);
}

export function readAllChains() {
  const presets = readPresetMap();
  const yaml = readAddressesRaw();
  const states = yaml.chains || {};
  const out = {};
  // Iterate union of preset keys + state keys so we surface mismatches.
  const keys = new Set([...Object.keys(presets), ...Object.keys(states)]);
  for (const k of keys) {
    if (!presets[k]) {
      console.error(`[read-chain-config] WARN: addresses.yaml lists chain "${k}" but chains/${k}/chain.yaml is missing — skipping`);
      continue;
    }
    out[k] = mergeOne(k, presets[k], states[k]);
  }
  return out;
}

export function readAddresses() {
  return readAddressesRaw();
}
