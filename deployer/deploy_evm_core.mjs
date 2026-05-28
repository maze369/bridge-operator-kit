// deploy_evm_core.mjs
// -------------------
// Deploy fresh Hyperlane v3 core on a pure-EVM chain (no Cosmos `warp` module).
// Generic across any EVM chain — driven by env vars + addresses.yaml.
//
// Deploys, in order:
//   1) StaticMessageIdMultisigIsmFactory (a CREATE2 factory)
//   2) Initial ISM via the factory (validators + threshold from env)
//   3) Mailbox (constructor: localDomain)
//   4) MerkleTreeHook (constructor: mailbox)
//   5) ValidatorAnnounce (constructor: mailbox)
//   6) Mailbox.initialize(owner=signer, ism, defaultHook=merkle, requiredHook=merkle)
//
// Output:
//   ./<chain>_evm_core.json with all addresses + deploy block + chainId.
//
// Usage:
//   NEW_CHAIN=mychain \
//   LOCAL_DOMAIN=1234 \
//   RPC=https://rpc.mychain.org \
//   VALIDATORS=0xv1,0xv2,0xv3 \
//   THRESHOLD=2 \
//     bash _run_deploy.sh deploy_evm_core.mjs
//
// Then update shared/addresses.yaml with the new chain's addresses, and run
// ADD_CHAIN.md's Step 3 (agent config update).
//
// For Cosmos SDK chains with the `warp` module, use Path A in ADD_CHAIN.md
// instead — those chains don't need Solidity contracts.

import { ethers } from 'ethers';
import * as core from '@hyperlane-xyz/core';
import fs from 'fs';
import path from 'path';

const PK = process.env.HYP_KEY;
const NEW_CHAIN = process.env.NEW_CHAIN;
const LOCAL_DOMAIN = parseInt(process.env.LOCAL_DOMAIN || '0', 10);
const RPC = process.env.RPC;
const VALIDATORS = (process.env.VALIDATORS || '').split(',').map(s => s.trim()).filter(Boolean);
const THRESHOLD = parseInt(process.env.THRESHOLD || '0', 10);

if (!PK) { console.error('FATAL HYP_KEY missing'); process.exit(2); }
if (!NEW_CHAIN) { console.error('FATAL NEW_CHAIN missing (chain key, e.g. "mychain")'); process.exit(2); }
if (!LOCAL_DOMAIN) { console.error('FATAL LOCAL_DOMAIN missing (Hyperlane domain — usually = chainId)'); process.exit(2); }
if (!RPC) { console.error('FATAL RPC missing'); process.exit(2); }
if (VALIDATORS.length === 0) { console.error('FATAL VALIDATORS empty (comma-separated 0x… addresses)'); process.exit(2); }
if (!THRESHOLD || THRESHOLD > VALIDATORS.length) {
  console.error(`FATAL THRESHOLD invalid (got ${THRESHOLD}, must be 1..${VALIDATORS.length})`);
  process.exit(2);
}

const RESULT = path.join('/work/deployer', `${NEW_CHAIN}_evm_core.json`);
const provider = new ethers.providers.JsonRpcProvider(RPC);
const signer = new ethers.Wallet(PK, provider);
const out = fs.existsSync(RESULT) ? JSON.parse(fs.readFileSync(RESULT)) : {};
const save = () => fs.writeFileSync(RESULT, JSON.stringify(out, null, 2));
const L = (...a) => console.log('[deploy-core]', ...a);
const hasCode = async a => { try { return a && (await provider.getCode(a)).length > 2; } catch { return false; } };

let OV, OVC;

async function dep(key, facName, args) {
  if (await hasCode(out[key])) { L(key, 'REUSE', out[key]); return out[key]; }
  const F = core[facName];
  if (!F) throw new Error(`factory ${facName} not in @hyperlane-xyz/core`);
  const cf = new ethers.ContractFactory(F.abi, F.bytecode, signer);
  const c = await cf.deploy(...args, OV);
  L(key, 'tx', c.deployTransaction.hash);
  const rcpt = await c.deployTransaction.wait();
  await c.deployed();
  out[key] = c.address;
  out[`${key}_block`] = rcpt.blockNumber;
  save();
  L(key, 'DEPLOYED', c.address, 'block', rcpt.blockNumber);
  return c.address;
}

(async () => {
  const net = await provider.getNetwork();
  const gp = ethers.BigNumber.from(await provider.send('eth_gasPrice', []));
  OV  = { maxFeePerGas: gp, maxPriorityFeePerGas: gp, gasLimit: 5000000, type: 2 };
  OVC = { maxFeePerGas: gp, maxPriorityFeePerGas: gp, gasLimit: 800000,  type: 2 };
  const bal = await provider.getBalance(signer.address);
  L('chain', NEW_CHAIN, 'chainId', net.chainId, 'domain', LOCAL_DOMAIN,
    'signer', signer.address, 'bal', ethers.utils.formatEther(bal),
    'gasPrice', gp.toString());
  if (net.chainId !== LOCAL_DOMAIN) {
    L('WARN: chainId', net.chainId, 'differs from LOCAL_DOMAIN', LOCAL_DOMAIN, '(allowed but unusual)');
  }
  if (bal.isZero()) { console.error('FATAL signer 0 balance — fund first'); process.exit(4); }

  out.chain = NEW_CHAIN;
  out.chainId = net.chainId;
  out.domain = LOCAL_DOMAIN;
  out.deployer = signer.address;
  out.validators = VALIDATORS;
  out.threshold = THRESHOLD;
  save();

  // 1) ISM factory
  const facA = await dep('ism_factory', 'StaticMessageIdMultisigIsmFactory__factory', []);

  // 2) ISM via factory — CREATE2, deterministic from (validators, threshold)
  const fac = new ethers.Contract(facA, core.StaticMessageIdMultisigIsmFactory__factory.abi, signer);
  let ism = out.ism;
  if (!(await hasCode(ism))) {
    ism = await fac.getAddress(VALIDATORS, THRESHOLD);
    if (!(await hasCode(ism))) {
      const t = await fac.deploy(VALIDATORS, THRESHOLD, OV);
      L('ism deploy tx', t.hash); await t.wait();
    }
    out.ism = ism; save();
    L('ism', ism, (await hasCode(ism)) ? '(code ok)' : '(NO CODE)');
  } else L('ism REUSE', ism);

  // 3) Mailbox + MerkleTreeHook + ValidatorAnnounce
  const mbx = await dep('mailbox', 'Mailbox__factory', [LOCAL_DOMAIN]);
  const merkle = await dep('merkleTreeHook', 'MerkleTreeHook__factory', [mbx]);
  await dep('validatorAnnounce', 'ValidatorAnnounce__factory', [mbx]);

  // 4) Initialize Mailbox(owner, defaultIsm, defaultHook, requiredHook).
  // requiredHook MUST be the merkle hook — without it the tree root never
  // advances and validators sign stale leaves.
  if (!out.mailbox_initialized) {
    const M = new ethers.Contract(mbx, core.Mailbox__factory.abi, signer);
    L('Mailbox.initialize(owner=signer, ism, merkle as default+required hook)');
    try {
      await (await M.initialize(signer.address, ism, merkle, merkle, OVC)).wait();
      out.mailbox_initialized = true; save(); L('mailbox initialized');
    } catch (e) {
      const m = e?.error?.message || e?.reason || e?.message || '';
      if (/already initialized|Initializable/i.test(m)) {
        out.mailbox_initialized = true; save(); L('mailbox was already initialized');
      } else throw e;
    }
  }

  L('DONE — Hyperlane core deployed on', NEW_CHAIN);
  L('Next: append to shared/addresses.yaml, then ADD_CHAIN Step 3 (agent config).');
  L('Addresses:', JSON.stringify(out, null, 2));
})().catch(e => {
  console.error('ERR', e?.error?.message || e?.reason || e?.message || e);
  save(); process.exit(1);
});
