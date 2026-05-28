#!/usr/bin/env node
// Build the bridge UI's state.json by merging:
//   - chains/<key>/chain.yaml — per-chain facts (RPC, mailbox, native, ...)
//   - shared/addresses.yaml — cross-chain live state (current ISM, validator
//     set, routers, enrollments, relayer roster)
//
// The UI fetches /bridge/state.json on load and uses it to render the
// chain picker, token picker, signer count, relayer list. Adding a chain
// = drop a chain.yaml + commit live state to addresses.yaml; the UI
// auto-picks it up on next page load.
//
// Usage:
//   node gen_state.mjs > ../ui-v2/state.json
//   node gen_state.mjs --check                 # validate without writing

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, '..');
const CHAINS_DIR = path.join(KIT_ROOT, 'chains');
const ADDR_YAML = path.join(KIT_ROOT, 'shared', 'addresses.yaml');

const KIND_TO_UI = {
  HypNative: 'native',
  HypERC20Collateral: 'collateral',
  HypERC20: 'synthetic',
  HypXERC20: 'xerc20',
};

// Auto-color from chain key when chain.yaml.color isn't set.
function colorFor(key, preset) {
  if (preset?.color) return preset.color;
  const palette = ['#3b82f6', '#00D2FF', '#9b87f5', '#f5a623', '#00E676', '#FF6B6B', '#FFD740'];
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}

function readChainPresets() {
  if (!fs.existsSync(CHAINS_DIR)) return {};
  const out = {};
  for (const e of fs.readdirSync(CHAINS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('_') || e.name.startsWith('.')) continue;
    const yp = path.join(CHAINS_DIR, e.name, 'chain.yaml');
    if (!fs.existsSync(yp)) continue;
    const c = parseYaml(fs.readFileSync(yp, 'utf8'));
    if (c && c.key) out[c.key] = c;
  }
  return out;
}

function uiChain(key, preset, state) {
  const chainId = Number(preset.chainId);
  return {
    key,
    name: preset.name || key,
    short: preset.shortLabel || key.slice(0, 2).toUpperCase(),
    chainId,
    hex: '0x' + chainId.toString(16),
    domain: Number(preset.domain ?? preset.chainId),
    rpc: (preset.rpcUrls || [])[0] || '',
    walletRpcUrls: preset.walletRpcUrls || preset.rpcUrls || [],
    scan: preset.blockExplorer || '',
    color: colorFor(key, preset),
    mailbox: preset.hyperlane?.mailbox || '',
    native: preset.native || { symbol: key.toUpperCase(), decimals: 18 },
    legacyGasPrice: preset.transactionOverrides?.gasPrice || null,
    // Cross-chain live state (current ISM, validator set, threshold).
    ism: state?.ism || '',
    ismValidators: state?.ismValidators || [],
    ismThreshold: Number(state?.ismThreshold ?? 0),
    owner: state?.owner || 'operator-key',
  };
}

function uiToken(presets, states, srcChain, srcSymbol, dstChain, dstSymbol) {
  const srcRouter = states[srcChain]?.routers?.[srcSymbol];
  const dstRouter = states[dstChain]?.routers?.[dstSymbol];
  if (!srcRouter || !dstRouter) return null;
  const srcKind = KIND_TO_UI[srcRouter.kind] || 'unknown';
  const dstKind = KIND_TO_UI[dstRouter.kind] || 'unknown';
  const src = { kind: srcKind, router: srcRouter.address, symbol: srcSymbol };
  const dst = { kind: dstKind, router: dstRouter.address, symbol: dstSymbol };
  if (srcKind === 'collateral' && srcRouter.underlying) src.erc20 = srcRouter.underlying;
  if (dstKind === 'collateral' && dstRouter.underlying) dst.erc20 = dstRouter.underlying;
  if (srcKind === 'xerc20' && srcRouter.underlying) src.erc20 = srcRouter.underlying;
  if (dstKind === 'xerc20' && dstRouter.underlying) dst.erc20 = dstRouter.underlying;
  // Token display name — strip leading "h" from synthetic to recover the underlying symbol
  // (h-prefix is this kit's convention for HypERC20 synthetics).
  const baseSymbol = srcSymbol.startsWith('h')
    ? srcSymbol.slice(1)
    : dstSymbol.startsWith('h') ? dstSymbol.slice(1) : srcSymbol;
  const dec = presets[srcChain]?.native?.symbol === srcSymbol
    ? presets[srcChain].native.decimals
    : (presets[dstChain]?.native?.symbol === dstSymbol ? presets[dstChain].native.decimals : 18);
  return {
    key: baseSymbol,
    name: baseSymbol,
    decimals: dec,
    src,
    dst,
  };
}

function build() {
  const presets = readChainPresets();
  const yaml = parseYaml(fs.readFileSync(ADDR_YAML, 'utf8'));
  const states = yaml.chains || {};

  // Sanity: warn about chains in addresses.yaml without a chain.yaml preset.
  for (const k of Object.keys(states)) {
    if (!presets[k]) {
      console.error(`[gen-state] WARN: addresses.yaml has chain "${k}" but no chains/${k}/chain.yaml — skipping`);
    }
  }

  const chainsOut = {};
  for (const [k, preset] of Object.entries(presets)) {
    chainsOut[k] = uiChain(k, preset, states[k]);
  }

  // Group enrollments by (from, to) chain pair → one route per pair.
  const grouped = {};
  for (const e of (yaml.enrollments || [])) {
    const [srcChain, srcSym] = e.source.split(':');
    const [dstChain, dstSym] = e.dest.split(':');
    if (!chainsOut[srcChain] || !chainsOut[dstChain]) continue;
    const key = `${srcChain}→${dstChain}`;
    if (!grouped[key]) {
      grouped[key] = {
        from: srcChain,
        to: dstChain,
        label: 'production',
        ismDest: chainsOut[dstChain].ism || '',
        tokens: [],
      };
    }
    const tok = uiToken(presets, states, srcChain, srcSym, dstChain, dstSym);
    if (!tok) continue;
    if (!grouped[key].tokens.find(t => t.key === tok.key)) {
      grouped[key].tokens.push(tok);
    }
  }
  const routes = Object.values(grouped).filter(r => r.tokens.length > 0);

  const relayers = (yaml.relayers || []).map(r => ({
    operator: r.operator,
    role: r.role || 'unspecified',
    delayMs: Number(r.delayMs ?? 0),
    signers: r.signers || {},
  }));

  return {
    generatedAt: new Date().toISOString(),
    source: 'operator-kit chains/*/chain.yaml + shared/addresses.yaml',
    chains: chainsOut,
    routes,
    relayers,
  };
}

const out = build();
const argv = process.argv.slice(2);
if (argv.includes('--check')) {
  console.error(`OK — ${Object.keys(out.chains).length} chains, ${out.routes.length} routes, ${out.routes.reduce((s, r) => s + r.tokens.length, 0)} tokens`);
} else {
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
