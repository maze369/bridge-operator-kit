// enroll_pair.mjs
// ---------------
// Cross-enroll a single warp-router pair between two chains. Idempotent.
//
// Usage (chain keys below must exist in shared/addresses.yaml):
//   SRC_CHAIN=chain-a \
//   SRC_ROUTER=0x... \
//   DST_CHAIN=chain-b \
//   DST_DOMAIN=99002 \
//   DST_ROUTER=0x... \
//     bash _run_deploy.sh enroll_pair.mjs
//
// What it does:
//   On SRC chain: srcRouter.enrollRemoteRouter(DST_DOMAIN, bytes32(DST_ROUTER))
//   On DST chain: dstRouter.enrollRemoteRouter(SRC_DOMAIN, bytes32(SRC_ROUTER))
//   Both calls are owner-gated (deployer key in Phase 1, multisig in Phase 2+).
//
// Reads chain RPCs + domains from ../shared/addresses.yaml; SRC_DOMAIN is
// derived from SRC_CHAIN. If you need to enroll between a chain not in
// addresses.yaml, add the chain there first (or via ADD_CHAIN).

import { ethers } from 'ethers';
import * as core from '@hyperlane-xyz/core';
import fs from 'fs';
import path from 'path';

// Hand-parse the bits we need (no yaml dep in the runner).
function readYamlChains(yamlPath) {
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const expanded = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] || `__MISSING_${n}__`);
  const chains = {};
  const lines = expanded.split('\n');
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (L.match(/^chains:\s*$/)) continue;
    const head = L.match(/^  ([a-z0-9_-]+):\s*$/);
    if (head) { current = head[1]; chains[current] = {}; continue; }
    if (!current) continue;
    if (L.match(/^[a-z]/i)) { current = null; continue; }
    const kv = L.match(/^    ([a-zA-Z_]+):\s*(.+)$/);
    if (kv) {
      let v = kv[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      chains[current][kv[1]] = v;
    }
    if (L.match(/^    rpcUrls:\s*$/)) {
      chains[current].rpcUrls = [];
      while (lines[i + 1]?.match(/^      - /)) {
        i++;
        chains[current].rpcUrls.push(lines[i].replace(/^      - /, '').trim());
      }
    }
  }
  return chains;
}

const PK = process.env.HYP_KEY;
const SRC_CHAIN = process.env.SRC_CHAIN;
const SRC_ROUTER = process.env.SRC_ROUTER;
const DST_CHAIN = process.env.DST_CHAIN;
const DST_ROUTER = process.env.DST_ROUTER;
let DST_DOMAIN = parseInt(process.env.DST_DOMAIN || '0', 10);

if (!PK) { console.error('FATAL HYP_KEY missing'); process.exit(2); }
for (const [k, v] of Object.entries({ SRC_CHAIN, SRC_ROUTER, DST_CHAIN, DST_ROUTER })) {
  if (!v) { console.error(`FATAL ${k} missing`); process.exit(2); }
}

const ADDR_YAML = '/work/shared/addresses.yaml';
const chains = readYamlChains(ADDR_YAML);
const src = chains[SRC_CHAIN];
const dst = chains[DST_CHAIN];
if (!src) { console.error(`FATAL ${SRC_CHAIN} not in addresses.yaml`); process.exit(3); }
if (!dst) { console.error(`FATAL ${DST_CHAIN} not in addresses.yaml`); process.exit(3); }

const SRC_DOMAIN = parseInt(src.domain, 10);
if (!DST_DOMAIN) DST_DOMAIN = parseInt(dst.domain, 10);

const srcRpc = src.rpcUrls?.[0];
const dstRpc = dst.rpcUrls?.[0];
if (!srcRpc || srcRpc.startsWith('__MISSING_')) { console.error(`FATAL ${SRC_CHAIN} RPC missing`); process.exit(3); }
if (!dstRpc || dstRpc.startsWith('__MISSING_')) { console.error(`FATAL ${DST_CHAIN} RPC missing`); process.exit(3); }

const srcProv = new ethers.providers.JsonRpcProvider(srcRpc);
const dstProv = new ethers.providers.JsonRpcProvider(dstRpc);
const srcSig = new ethers.Wallet(PK, srcProv);
const dstSig = new ethers.Wallet(PK, dstProv);

const toBytes32 = a => ethers.utils.hexZeroPad(a, 32);
const L = (...a) => console.log('[enroll-pair]', ...a);

async function ovr(provider, ch) {
  if (ch && ch.legacyGasPrice) {
    return {
      gasPrice: ethers.BigNumber.from(ch.legacyGasPrice),
      gasLimit: 500000, type: 0,
    };
  }
  const gp = ethers.BigNumber.from(await provider.send('eth_gasPrice', []));
  return { maxFeePerGas: gp, maxPriorityFeePerGas: gp, gasLimit: 500000, type: 2 };
}

async function enroll(label, router, signer, provider, remoteDom, remoteRouter, ch) {
  // Generic enroll — the Router ABI is the same across HypNative/HypERC20/HypERC20Collateral.
  const R = new ethers.Contract(router, core.HypERC20__factory.abi, signer);
  let cur;
  try { cur = await R.routers(remoteDom); } catch (e) { cur = '0x' + '00'.repeat(32); }
  const want = toBytes32(remoteRouter).toLowerCase();
  if (cur.toLowerCase() === want) {
    L(label, 'ALREADY enrolled', remoteDom, '→', remoteRouter);
    return 'already';
  }
  L(label, 'enrolling', remoteDom, '→', remoteRouter);
  const ov = await ovr(provider, ch);
  const tx = await R.enrollRemoteRouter(remoteDom, toBytes32(remoteRouter), ov);
  L(label, 'tx', tx.hash);
  await tx.wait();
  L(label, 'enrolled');
  return 'ok';
}

(async () => {
  L('SRC', SRC_CHAIN, 'dom', SRC_DOMAIN, 'router', SRC_ROUTER);
  L('DST', DST_CHAIN, 'dom', DST_DOMAIN, 'router', DST_ROUTER);

  const a = await enroll(
    `${SRC_CHAIN} → ${DST_CHAIN}`,
    SRC_ROUTER, srcSig, srcProv, DST_DOMAIN, DST_ROUTER, src
  );
  const b = await enroll(
    `${DST_CHAIN} → ${SRC_CHAIN}`,
    DST_ROUTER, dstSig, dstProv, SRC_DOMAIN, SRC_ROUTER, dst
  );

  L('DONE — pair enrollment:', a, '/', b);
})().catch(e => {
  console.error('ERR', e?.error?.message || e?.reason || e?.message || e);
  process.exit(1);
});
