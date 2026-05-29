// Deploy a new MessageIdMultisigISM via the factory with the given
// validators + threshold, then swap it into every warp router on every
// registered chain. Idempotent — a router already pointing at this ISM
// is skipped; an ISM whose CREATE2 address already has bytecode is reused.
//
// Args via env:
//   VALIDATORS = comma-separated 0x addrs (factory sorts internally).
//                If unset, taken from addresses.yaml (union across chains).
//   THRESHOLD  = integer (≤ N validators). If unset, taken from the first
//                chain's ismThreshold in addresses.yaml.
//
// Chain configuration is merged from chains/<key>/chain.yaml (static facts:
// rpcUrls, ismFactory, mailbox, ...) + shared/addresses.yaml (live state:
// routers, ismValidators, ...). See tools/read_chain_config.mjs.
//
// Appends every (validators, threshold, deployed ISMs) tuple to
// /work/deployer/ism_history.json for audit.
import { ethers } from 'ethers';
import * as core from '@hyperlane-xyz/core';
import fs from 'fs';
import { readAllChains } from '/work/tools/read_chain_config.mjs';

const PK = process.env.HYP_KEY;

// Per-chain owner key override: when routers on different chains are
// owned by different keys (defensive blast-radius pattern), set
// HYP_KEY_<CHAIN_UPPER> for each. Falls back to HYP_KEY if unset.
function keyForChain(chainKey) {
  const envKey = `HYP_KEY_${chainKey.toUpperCase()}`;
  return process.env[envKey] || PK;
}

if (!PK) { console.error('FATAL need HYP_KEY'); process.exit(2); }

const chains = readAllChains();

// Resolve VALIDATORS + THRESHOLD: caller-provided env wins; otherwise
// derive from addresses.yaml (union of validators, first chain's threshold).
let VALIDATORS = (process.env.VALIDATORS || '').split(',').map(s => s.trim()).filter(Boolean);
let THRESHOLD = parseInt(process.env.THRESHOLD || '0', 10);
if (VALIDATORS.length === 0) {
  // Dedup by lowercase but emit checksummed addresses — ethers v5 is strict
  // about checksums in factory.getAddress() / setInterchainSecurityModule.
  const seen = new Set();
  for (const c of Object.values(chains)) {
    for (const v of (c.ismValidators || [])) {
      const lc = v.toLowerCase();
      if (seen.has(lc)) continue;
      seen.add(lc);
      VALIDATORS.push(ethers.utils.getAddress(v));
    }
  }
}
if (THRESHOLD === 0) {
  THRESHOLD = Object.values(chains).find(c => c.ismThreshold)?.ismThreshold || 0;
}
if (VALIDATORS.length === 0 || THRESHOLD === 0) {
  console.error('FATAL need VALIDATORS + THRESHOLD (env or addresses.yaml)'); process.exit(2);
}
if (THRESHOLD > VALIDATORS.length) {
  console.error(`FATAL: threshold ${THRESHOLD} > N validators ${VALIDATORS.length}`); process.exit(2);
}

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

// Resolve the target ISM for this chain.
//
// Priority:
//   1. If addresses.yaml.chains.<k>.ism is set (non-zero, has bytecode),
//      treat it as the canonical target. This is the working live ISM —
//      possibly deployed via a factory different from chain.yaml's
//      ismFactory (e.g., a MerkleRoot variant, or a legacy deployer's
//      factory). Don't second-guess working state.
//   2. Otherwise, deploy a fresh ISM via the chain.yaml ismFactory using
//      CREATE2(VALIDATORS, THRESHOLD), and update addresses.yaml.ism via
//      ism_history.json afterward.
//
// FORCE_REDEPLOY_ISM=1 — bypass (1) and always deploy a fresh CREATE2 ISM.
// Use this when you actually want to rotate validator sets, not just sync.
async function resolveIsmForChain(chainKey, ch) {
  const rpc = ch.rpcUrls?.[0];
  if (!rpc || rpc.startsWith('__MISSING_')) throw new Error(`${chainKey}: no usable RPC (got "${rpc}")`);
  const p = new ethers.providers.JsonRpcProvider(rpc);

  // Normalize the declared ISM to a valid checksummed address (ethers v5
  // strict mode rejects mixed-case-with-wrong-checksum; addresses.yaml
  // values come from on-chain probes and may not be checksummed).
  const rawIsm = ch.ism;
  const isPlaceholder = !rawIsm
    || rawIsm === '0x0000000000000000000000000000000000000000'
    || /^__MISSING_/.test(rawIsm);
  const declaredIsm = isPlaceholder ? null : ethers.utils.getAddress(rawIsm.toLowerCase());
  const forceRedeploy = process.env.FORCE_REDEPLOY_ISM === '1';

  if (!isPlaceholder && !forceRedeploy) {
    const code = await p.getCode(declaredIsm);
    if (code.length <= 2) {
      throw new Error(
        `${chainKey}: addresses.yaml lists ism=${declaredIsm} but no bytecode at that address. ` +
        `Fix the yaml or set FORCE_REDEPLOY_ISM=1 to deploy a fresh one.`
      );
    }
    L(`${chainKey} target ISM (from addresses.yaml): ${declaredIsm}`);
    return { ism: declaredIsm, deployed: false };
  }

  // Deploy a new ISM.
  L(`=== deploy ISM on ${chainKey} ===`);
  if (!ch.ismFactory) throw new Error(`${chainKey}: ismFactory missing in chains/${chainKey}/chain.yaml`);
  const s = new ethers.Wallet(keyForChain(chainKey), p);
  const fac = new ethers.Contract(ethers.utils.getAddress(ch.ismFactory.toLowerCase()), core.StaticMessageIdMultisigIsmFactory__factory.abi, s);
  const predicted = await fac.getAddress(VALIDATORS, THRESHOLD);
  const code = await p.getCode(predicted);
  if (code.length > 2) {
    L(`${chainKey} ISM already at predicted ${predicted}`);
    return { ism: predicted, deployed: true };
  }
  const ov = await ovr(p, ch, 800_000);
  const tx = await fac.deploy(VALIDATORS, THRESHOLD, ov);
  L(`${chainKey} deploy tx ${tx.hash}`);
  await tx.wait();
  L(`${chainKey} new ISM ${predicted}`);
  return { ism: predicted, deployed: true };
}

async function swapIsmInRouter(chainKey, ch, routerLabel, routerAddr, newIsm) {
  const rpc = ch.rpcUrls?.[0];
  const p = new ethers.providers.JsonRpcProvider(rpc);
  const s = new ethers.Wallet(keyForChain(chainKey), p);
  const R = new ethers.Contract(ethers.utils.getAddress(routerAddr.toLowerCase()), core.HypERC20__factory.abi, s);
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
  const deployedIsms = {};   // chain -> resolved ISM address (may pre-exist)
  const freshlyDeployed = {}; // chain -> true if THIS run deployed it
  for (const k of chainKeys) {
    const r = await resolveIsmForChain(k, chains[k]);
    deployedIsms[k] = r.ism;
    freshlyDeployed[k] = r.deployed;
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
  // Only write history for chains where we deployed a fresh ISM (i.e.,
  // resolved via CREATE2). Pre-existing ISMs taken from addresses.yaml
  // don't need a yaml writeback — they're already canonical there.
  const newlyDeployed = Object.fromEntries(
    Object.entries(deployedIsms).filter(([k]) => freshlyDeployed[k])
  );
  if (Object.keys(newlyDeployed).length) {
    h.push({
      ts: new Date().toISOString(),
      validators: VALIDATORS,
      threshold: THRESHOLD,
      deployedIsms: newlyDeployed,
    });
    fs.writeFileSync(HIST, JSON.stringify(h, null, 2));
  }

  L('DONE — target ISM per chain:');
  for (const k of chainKeys) {
    const tag = freshlyDeployed[k] ? '(fresh deploy)' : '(from yaml)';
    L(`  ${k}: ${deployedIsms[k]} ${tag}`);
  }
})().catch(e => { console.error('ERR', e?.error?.message || e?.reason || e?.message || e); process.exit(1); });
