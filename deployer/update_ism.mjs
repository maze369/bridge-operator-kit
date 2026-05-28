// Deploy a new MessageIdMultisigISM via the factory with the given
// validators + threshold, then swap it into every warp router on both
// chains. Idempotent — a router already pointing at this ISM is skipped.
//
// Args via env:
//   VALIDATORS = comma-separated 0x addrs (factory sorts internally)
//   THRESHOLD  = integer (≤ N validators)
//
// Reads chain + router addresses from /work/shared/addresses.yaml. Each
// chain's section must include:
//   rpcUrls: [...]
//   ismFactory: 0x... (StaticMessageIdMultisigIsmFactory)
//   routers: { <symbol>: { kind, address } }
//
// Appends every (validators, threshold, deployed ISMs) tuple to
// /work/deployer/ism_history.json for audit.
import { ethers } from 'ethers';
import * as core from '@hyperlane-xyz/core';
import fs from 'fs';

const PK = process.env.HYP_KEY;
const VALIDATORS = (process.env.VALIDATORS || '').split(',').map(s => s.trim()).filter(Boolean);
const THRESHOLD = parseInt(process.env.THRESHOLD || '0', 10);

// Per-chain owner key override: when routers on different chains are
// owned by different keys (defensive blast-radius pattern), set
// HYP_KEY_<CHAIN_UPPER> for each. Falls back to HYP_KEY if unset.
function keyForChain(chainKey) {
  const envKey = `HYP_KEY_${chainKey.toUpperCase()}`;
  return process.env[envKey] || PK;
}

if (!PK || VALIDATORS.length === 0 || THRESHOLD === 0) {
  console.error('FATAL need HYP_KEY + VALIDATORS + THRESHOLD'); process.exit(2);
}
if (THRESHOLD > VALIDATORS.length) {
  console.error(`FATAL: threshold ${THRESHOLD} > N validators ${VALIDATORS.length}`); process.exit(2);
}

// Hand-parse the bits we need from addresses.yaml (no yaml dep in the
// runner). Same approach the other deployer scripts use.
function readChains(yamlPath) {
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const expanded = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] || `__MISSING_${n}__`);
  const chains = {};
  const lines = expanded.split('\n');
  let current = null;
  let inRouters = false;
  let currentRouter = null;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.match(/^chains:\s*$/)) continue;

    const head = L.match(/^  ([a-z0-9_-]+):\s*$/);
    if (head) {
      current = head[1];
      chains[current] = { routers: {} };
      inRouters = false;
      currentRouter = null;
      continue;
    }
    if (!current) continue;
    if (L.match(/^[a-z]/i)) { current = null; inRouters = false; continue; }

    // routers: block header (bare key, no value)
    if (L.match(/^    routers:\s*$/)) { inRouters = true; continue; }

    // Scalar kv at chain level.
    const kv = L.match(/^    ([a-zA-Z_]+):\s*(.+)$/);
    if (kv) {
      const key = kv[1];
      let v = kv[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      chains[current][key] = v;
      inRouters = false;
      continue;
    }

    // rpcUrls list at chain level.
    if (L.match(/^    rpcUrls:\s*$/)) {
      chains[current].rpcUrls = [];
      while (lines[i + 1]?.match(/^      - /)) {
        i++;
        chains[current].rpcUrls.push(lines[i].replace(/^      - /, '').trim());
      }
      continue;
    }

    // Routers block.
    if (inRouters) {
      const rh = L.match(/^      ([A-Za-z0-9_]+):\s*$/);
      if (rh) {
        currentRouter = rh[1];
        chains[current].routers[currentRouter] = {};
        continue;
      }
      const rkv = L.match(/^        ([a-zA-Z_]+):\s*(.+)$/);
      if (rkv && currentRouter) {
        let v = rkv[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
        chains[current].routers[currentRouter][rkv[1]] = v;
        continue;
      }
    }
  }
  return chains;
}

const ADDR_YAML = '/work/shared/addresses.yaml';
const chains = readChains(ADDR_YAML);
const HIST = '/work/deployer/ism_history.json';

const L = (...a) => console.log('[ism]', ...a);

// Per-chain overrides: legacy (type 0) if the chain pins legacyGasPrice
// in addresses.yaml, otherwise dynamic EIP-1559 (type 2).
async function ovr(p, ch, gas = 5000000) {
  if (ch && ch.legacyGasPrice) {
    return {
      gasPrice: ethers.BigNumber.from(ch.legacyGasPrice),
      gasLimit: gas, type: 0,
    };
  }
  const gp = ethers.BigNumber.from(await p.send('eth_gasPrice', []));
  return { maxFeePerGas: gp, maxPriorityFeePerGas: gp, gasLimit: gas, type: 2 };
}

async function deployIsmOn(chainKey, ch) {
  L(`=== deploy ISM on ${chainKey} ===`);
  if (!ch.ismFactory) throw new Error(`${chainKey}: ismFactory missing in addresses.yaml`);
  const rpc = ch.rpcUrls?.[0];
  if (!rpc || rpc.startsWith('__MISSING_')) throw new Error(`${chainKey}: no usable RPC (got "${rpc}")`);

  const p = new ethers.providers.JsonRpcProvider(rpc);
  const s = new ethers.Wallet(keyForChain(chainKey), p);
  const fac = new ethers.Contract(ch.ismFactory, core.StaticMessageIdMultisigIsmFactory__factory.abi, s);
  // CREATE2 address derived from (validators, threshold) — same tuple = same instance.
  const predicted = await fac.getAddress(VALIDATORS, THRESHOLD);
  const code = await p.getCode(predicted);
  if (code.length > 2) {
    L(`${chainKey} ISM already exists at ${predicted}`);
    return predicted;
  }
  // Factory.deploy is ~300-500k gas (small MetaProxy). 800k cap keeps
  // flat-fee chains (those with a large constant gas price set via
  // `legacyGasPrice:` in addresses.yaml) from being billed for a 5M
  // limit on a 300k-gas tx. EIP-1559 chains charge only gas_used, so
  // over-provisioning is harmless there.
  const ov = await ovr(p, ch, 800_000);
  const tx = await fac.deploy(VALIDATORS, THRESHOLD, ov);
  L(`${chainKey} deploy tx ${tx.hash}`);
  await tx.wait();
  L(`${chainKey} new ISM ${predicted}`);
  return predicted;
}

async function swapIsmInRouter(chainKey, ch, routerLabel, routerAddr, newIsm) {
  const rpc = ch.rpcUrls?.[0];
  const p = new ethers.providers.JsonRpcProvider(rpc);
  const s = new ethers.Wallet(keyForChain(chainKey), p);
  const R = new ethers.Contract(routerAddr, core.HypERC20__factory.abi, s);
  const current = await R.interchainSecurityModule();
  if (current.toLowerCase() === newIsm.toLowerCase()) {
    L(`${chainKey} ${routerLabel} already using ISM ${newIsm.slice(0, 10)}..`);
    return;
  }
  L(`${chainKey} ${routerLabel} swap ISM ${current.slice(0, 10)}.. → ${newIsm.slice(0, 10)}..`);
  const ov = await ovr(p, ch, 500000);
  const tx = await R.setInterchainSecurityModule(newIsm, ov);
  L(`${chainKey} ${routerLabel} tx ${tx.hash}`);
  await tx.wait();
  L(`${chainKey} ${routerLabel} swapped`);
}

(async () => {
  L('validators', VALIDATORS, 'threshold', THRESHOLD);

  // CHAIN_FILTER lets the caller restrict the operation to a subset of
  // chains. Used when per-chain validator sets diverge — e.g. a smaller
  // validator set on one chain than the others. Comma-separated whitelist
  // of chain keys (matching keys in shared/addresses.yaml).
  const filter = (process.env.CHAIN_FILTER || '').split(',').map(s => s.trim()).filter(Boolean);
  const chainKeys = Object.keys(chains).filter(k => filter.length === 0 || filter.includes(k));
  if (filter.length) L(`CHAIN_FILTER restricts to: ${chainKeys.join(', ')}`);
  const deployedIsms = {};
  for (const k of chainKeys) {
    deployedIsms[k] = await deployIsmOn(k, chains[k]);
  }

  // SKIP_ROUTER_SWAP=1 — used by Phase 2/3 callers (promote_operator.sh)
  // that handle the owner-gated setIsm call via Safe-tx or Governor proposal
  // outside this script. We still deploy the ISM (permissionless via factory)
  // so the caller has the address to encode into the proposal/Safe payload.
  if (process.env.SKIP_ROUTER_SWAP === '1') {
    L('SKIP_ROUTER_SWAP=1 — ISM(s) deployed, router swap left to caller (Phase 2/3)');
  } else {
    for (const k of chainKeys) {
      const ch = chains[k];
      for (const [routerLabel, rt] of Object.entries(ch.routers || {})) {
        if (!rt.address) continue;
        await swapIsmInRouter(k, ch, routerLabel, rt.address, deployedIsms[k]);
      }
    }
  }

  let h = [];
  if (fs.existsSync(HIST)) { try { h = JSON.parse(fs.readFileSync(HIST)); } catch {} }
  h.push({
    ts: new Date().toISOString(),
    validators: VALIDATORS,
    threshold: THRESHOLD,
    deployedIsms,
  });
  fs.writeFileSync(HIST, JSON.stringify(h, null, 2));

  L('DONE — new ISM in effect:');
  for (const k of chainKeys) L(`  ${k}: ${deployedIsms[k]}`);
})().catch(e => { console.error('ERR', e?.error?.message || e?.reason || e?.message || e); process.exit(1); });
