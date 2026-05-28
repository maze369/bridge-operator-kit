// set_router_ism.mjs
// ------------------
// Set the InterchainSecurityModule on a single warp router. Owner-gated.
//
// Usage (CHAIN must exist in shared/addresses.yaml):
//   CHAIN=chain-a \
//   ROUTER=0x... \
//   ISM=0x... \
//     bash _run_deploy.sh set_router_ism.mjs
//
// Use this when you want a token-specific ISM (e.g., higher threshold for a
// high-value asset). For routers using the chain's default ISM, skip — they
// inherit automatically.
//
// Idempotent — already-correct ISM is detected and no tx is sent.

import { ethers } from 'ethers';
import * as core from '@hyperlane-xyz/core';
import fs from 'fs';

function readYamlChain(yamlPath, chainKey) {
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const expanded = raw.replace(/\$\{([A-Z0-9_]+)\}/g, (_, n) => process.env[n] || `__MISSING_${n}__`);
  const lines = expanded.split('\n');
  let inChain = false, ch = {};
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const m = L.match(/^  ([a-z0-9_-]+):\s*$/);
    if (m) { inChain = (m[1] === chainKey); continue; }
    if (!inChain) continue;
    if (L.match(/^[a-z]/i)) break;
    const kv = L.match(/^    ([a-zA-Z_]+):\s*(.+)$/);
    if (kv) {
      let v = kv[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
      ch[kv[1]] = v;
    }
    if (L.match(/^    rpcUrls:\s*$/)) {
      ch.rpcUrls = [];
      while (lines[i + 1]?.match(/^      - /)) {
        i++;
        ch.rpcUrls.push(lines[i].replace(/^      - /, '').trim());
      }
    }
  }
  return ch;
}

const PK = process.env.HYP_KEY;
const CHAIN = process.env.CHAIN;
const ROUTER = process.env.ROUTER;
const ISM = process.env.ISM;

if (!PK)     { console.error('FATAL HYP_KEY missing'); process.exit(2); }
if (!CHAIN)  { console.error('FATAL CHAIN missing'); process.exit(2); }
if (!ROUTER) { console.error('FATAL ROUTER missing'); process.exit(2); }
if (!ISM)    { console.error('FATAL ISM missing'); process.exit(2); }

const ch = readYamlChain('/work/shared/addresses.yaml', CHAIN);
const rpc = ch.rpcUrls?.[0];
if (!rpc || rpc.startsWith('__MISSING_')) {
  console.error(`FATAL chain "${CHAIN}" RPC unavailable`); process.exit(3);
}

const provider = new ethers.providers.JsonRpcProvider(rpc);
const signer = new ethers.Wallet(PK, provider);
const L = (...a) => console.log('[set-router-ism]', ...a);

async function buildOverrides(gasLimit) {
  if (ch.legacyGasPrice) {
    return {
      gasPrice: ethers.BigNumber.from(ch.legacyGasPrice),
      gasLimit, type: 0,
    };
  }
  const gp = ethers.BigNumber.from(await provider.send('eth_gasPrice', []));
  return { maxFeePerGas: gp, maxPriorityFeePerGas: gp, gasLimit, type: 2 };
}

(async () => {
  const ov = await buildOverrides(800000);

  const R = new ethers.Contract(ROUTER, core.HypERC20__factory.abi, signer);
  const cur = await R.interchainSecurityModule();
  L('chain', CHAIN, 'router', ROUTER);
  L('current ISM:', cur);
  L('target ISM: ', ISM);
  if (cur.toLowerCase() === ISM.toLowerCase()) {
    L('ALREADY set — no-op');
    return;
  }
  const tx = await R.setInterchainSecurityModule(ISM, ov);
  L('tx', tx.hash);
  await tx.wait();
  L('DONE');
})().catch(e => {
  console.error('ERR', e?.error?.message || e?.reason || e?.message || e);
  process.exit(1);
});
