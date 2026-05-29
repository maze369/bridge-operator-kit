// deploy_warp_router.mjs
// ----------------------
// Deploys one Hyperlane v3 warp router on a given chain. Generic across
// HypNative, HypERC20Collateral, and HypERC20 (synthetic).
//
// Usage (via _run_deploy.sh): CHAIN keys below must exist in
// shared/addresses.yaml. Examples use placeholder keys chain-a / chain-b
// — substitute with your bridge's chain keys.
//
//   # Lock the chain's native asset, mint synthetic on the other side
//   SRC_CHAIN=chain-a \
//   ROUTER_KIND=HypNative \
//     bash _run_deploy.sh deploy_warp_router.mjs
//
//   # Lock an existing ERC20 (e.g. USDC) on the source chain
//   SRC_CHAIN=chain-a \
//   ROUTER_KIND=HypERC20Collateral \
//   UNDERLYING=0x0000000000000000000000000000000000000000 \
//     bash _run_deploy.sh deploy_warp_router.mjs
//
//   # Mint the synthetic receiving side on the destination chain
//   DST_CHAIN=chain-b \
//   ROUTER_KIND=HypERC20 \
//   SYMBOL=hNATIVE NAME="Hyperlane Native" DECIMALS=18 \
//     bash _run_deploy.sh deploy_warp_router.mjs
//
// Outputs:
//   ./warp_<symbol>_<chain>.json with { kind, chain, address, mailbox, symbol,
//     decimals, deployer, txHash, deployBlock }
//   Same data printed at end of stdout.
//
// Reads chain config from ../shared/addresses.yaml. Refuses to run if the
// requested chain isn't declared there.

import { ethers } from 'ethers';
import * as core from '@hyperlane-xyz/core';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'node:child_process';
import { readChainConfig } from '/work/tools/read_chain_config.mjs';

const KIT_ROOT = '/work';
const PK = process.env.HYP_KEY;
const CHAIN = process.env.SRC_CHAIN || process.env.DST_CHAIN;
const KIND = process.env.ROUTER_KIND;
const UNDERLYING = process.env.UNDERLYING || '';
const SYMBOL = process.env.SYMBOL || '';
const NAME = process.env.NAME || (SYMBOL ? `Hyperlane ${SYMBOL.replace(/^h/, '')}` : '');
const DECIMALS = parseInt(process.env.DECIMALS || '18', 10);

// Auto-register the deployed router in addresses.yaml unless explicitly
// suppressed (SKIP_YAML_REGISTER=1). Default: register. This is what makes
// the bridge admin tools "see" the new router for ISM swaps + state.json.
const REGISTER_IN_YAML = process.env.SKIP_YAML_REGISTER !== '1';

if (!PK) { console.error('FATAL HYP_KEY missing'); process.exit(2); }
if (!CHAIN) { console.error('FATAL SRC_CHAIN or DST_CHAIN must be set'); process.exit(2); }
if (!KIND) { console.error('FATAL ROUTER_KIND missing (HypNative|HypERC20Collateral|HypERC20|HypXERC20)'); process.exit(2); }
if (KIND === 'HypERC20Collateral' && !UNDERLYING) {
  console.error('FATAL HypERC20Collateral requires UNDERLYING=<erc20 address>'); process.exit(2);
}
if (KIND === 'HypXERC20' && !UNDERLYING) {
  console.error('FATAL HypXERC20 requires UNDERLYING=<xerc20 address>'); process.exit(2);
}
if (KIND === 'HypERC20' && !SYMBOL) {
  console.error('FATAL HypERC20 requires SYMBOL=<token symbol> (NAME + DECIMALS optional)'); process.exit(2);
}

const chCfg = readChainConfig(CHAIN);
if (!chCfg.mailbox) {
  console.error(`FATAL chain "${CHAIN}" has no mailbox — register chains/${CHAIN}/chain.yaml first (see ADD_CHAIN.md)`);
  process.exit(3);
}
const RPC = chCfg.rpcUrls?.[0];
if (!RPC || RPC.startsWith('__MISSING_')) {
  console.error(`FATAL chain "${CHAIN}" has no usable RPC (got "${RPC}"). Fix chains/${CHAIN}/chain.yaml.`);
  process.exit(3);
}

const RESULT = path.join('/work/deployer', `warp_${(SYMBOL || KIND).replace(/[^A-Za-z0-9]/g, '_')}_${CHAIN}.json`);
const provider = new ethers.providers.JsonRpcProvider(RPC);
const signer = new ethers.Wallet(PK, provider);

const out = fs.existsSync(RESULT) ? JSON.parse(fs.readFileSync(RESULT)) : {};
const save = () => fs.writeFileSync(RESULT, JSON.stringify(out, null, 2));
const L = (...a) => console.log('[warp-deploy]', ...a);

async function hasCode(a) { try { return a && (await provider.getCode(a)).length > 2; } catch { return false; } }

// Build a chain-appropriate tx overrides object. Chains with legacyGasPrice
// in addresses.yaml use type-0 legacy gas with that exact price; lander's 2x
// buffer doesn't apply at deploy time, but EIP-1559 isn't supported anyway.
// Other chains: dynamic EIP-1559.
async function buildOverrides(gasLimit) {
  if (chCfg.legacyGasPrice) {
    return {
      gasPrice: ethers.BigNumber.from(chCfg.legacyGasPrice),
      gasLimit, type: 0,
    };
  }
  const gp = ethers.BigNumber.from(await provider.send('eth_gasPrice', []));
  return { maxFeePerGas: gp, maxPriorityFeePerGas: gp, gasLimit, type: 2 };
}

(async () => {
  const net = await provider.getNetwork();
  const OV  = await buildOverrides(5000000);
  const OVC = await buildOverrides(800000);
  const gpReport = (OV.gasPrice || OV.maxFeePerGas).toString();
  const bal = await provider.getBalance(signer.address);
  L('chain', CHAIN, 'chainId', net.chainId, 'kind', KIND,
    'mailbox', chCfg.mailbox, 'signer', signer.address,
    'bal', ethers.utils.formatEther(bal), 'gasPrice', gpReport, 'txType', OV.type);
  if (bal.isZero()) { console.error('FATAL signer has 0 native balance — fund it first'); process.exit(4); }

  // Reuse if a prior deploy succeeded
  if (out.address && await hasCode(out.address)) {
    L('REUSE existing router', out.address);
    L('DONE', JSON.stringify(out, null, 2));
    return;
  }

  let factory, ctorArgs, postDeploy;
  if (KIND === 'HypNative') {
    factory = core.HypNative__factory;
    ctorArgs = [chCfg.mailbox];
  } else if (KIND === 'HypERC20Collateral') {
    factory = core.HypERC20Collateral__factory;
    ctorArgs = [UNDERLYING, chCfg.mailbox];
  } else if (KIND === 'HypERC20') {
    factory = core.HypERC20__factory;
    ctorArgs = [DECIMALS, chCfg.mailbox];
    postDeploy = async (c) => {
      try {
        await (await c.initialize(0, NAME, SYMBOL, OVC)).wait();
        L('initialized', SYMBOL);
      } catch (e) {
        const m = e?.error?.message || e?.reason || e?.message || '';
        if (!/already initialized|Initializable/i.test(m)) throw e;
        L('initialize skipped — already initialized');
      }
    };
  } else if (KIND === 'HypXERC20') {
    // EIP-7281 xERC20 wrapper. The router calls mint/burn on the underlying
    // xERC20; bridging limits are enforced inside the xERC20 (caller must
    // set them via xerc20.setLimits(router, mint, burn) — see ADD_TOKEN.md).
    factory = core.HypXERC20__factory;
    ctorArgs = [UNDERLYING, chCfg.mailbox];
  } else {
    console.error(`FATAL unknown ROUTER_KIND "${KIND}"`); process.exit(2);
  }

  const cf = new ethers.ContractFactory(factory.abi, factory.bytecode, signer);
  const c = await cf.deploy(...ctorArgs, OV);
  L('deploy tx', c.deployTransaction.hash);
  const rcpt = await c.deployed().then(() => c.deployTransaction.wait());

  out.kind = KIND;
  out.chain = CHAIN;
  out.address = c.address;
  out.mailbox = chCfg.mailbox;
  out.symbol = SYMBOL || (KIND === 'HypNative' ? '<native>' : '<collateral>');
  out.decimals = DECIMALS;
  out.underlying = UNDERLYING || null;
  out.deployer = signer.address;
  out.txHash = rcpt.transactionHash;
  out.deployBlock = rcpt.blockNumber;
  out.deployedAt = new Date().toISOString();
  save();
  L('deployed', c.address, 'block', rcpt.blockNumber);

  if (postDeploy) await postDeploy(c);

  // Auto-register in shared/addresses.yaml so admin tools (update_ism,
  // gen_state) see the new router. SKIP_YAML_REGISTER=1 to bypass.
  if (REGISTER_IN_YAML) {
    const sym = out.symbol === '<native>' || out.symbol === '<collateral>'
      ? (chCfg.native?.symbol || CHAIN.toUpperCase()) : out.symbol;
    try {
      const args = ['/work/tools/yaml_promote.mjs', 'add-router', CHAIN, sym, KIND, out.address];
      if (UNDERLYING) args.push(UNDERLYING);
      const res = execFileSync('node', args, { encoding: 'utf8', cwd: '/work/tools' });
      L('yaml registered:', res.trim());
    } catch (e) {
      // Non-fatal: log + move on. Operator can re-run `yaml_promote add-router`
      // manually if needed (e.g. yaml deps not installed in the runner).
      L('WARN: yaml registration failed (router still deployed on-chain):',
        e?.stdout?.toString() || e?.message || e);
    }
  } else {
    L('SKIP_YAML_REGISTER=1 — caller will register the router manually');
  }

  L('DONE', JSON.stringify(out, null, 2));
})().catch(e => {
  console.error('ERR', e?.error?.message || e?.reason || e?.message || e);
  save(); process.exit(1);
});
