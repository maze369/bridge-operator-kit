#!/usr/bin/env node
// detect_admin_mode.mjs — figure out which phase a router is in, by reading
// its owner() and classifying.
//
// Usage:  RPC=<rpc_url> ROUTER=<0x...> node detect_admin_mode.mjs
//         → prints one of: "broadcast" | "safe-tx" | "proposal" | "unknown"
//
// Phase 1 (broadcast): owner is an EOA (no code at that address).
// Phase 2 (safe-tx)  : owner is a contract that responds to Gnosis Safe's
//                      `getOwners()` view.
// Phase 3 (proposal) : owner is a contract that responds to OZ Timelock's
//                      `getMinDelay()` view.
// Otherwise: unknown — the caller must pick a mode explicitly.

import { ethers } from 'ethers';

const RPC = process.env.RPC;
const ROUTER = process.env.ROUTER;
if (!RPC || !ROUTER) {
  console.error('FATAL set RPC=<rpc> ROUTER=<0x...>');
  process.exit(2);
}

// ethers v6 namespace (v5 used ethers.providers.JsonRpcProvider).
const p = new ethers.JsonRpcProvider(RPC);

const OWNABLE_ABI = ['function owner() view returns (address)'];
const SAFE_ABI    = ['function getOwners() view returns (address[])'];
const TIMELOCK_ABI = ['function getMinDelay() view returns (uint256)'];

async function main() {
  const r = new ethers.Contract(ROUTER, OWNABLE_ABI, p);
  const owner = await r.owner();
  const code = await p.getCode(owner);
  if (!code || code === '0x') {
    process.stdout.write('broadcast\n');
    return;
  }
  // Try Safe.getOwners()
  try {
    const safe = new ethers.Contract(owner, SAFE_ABI, p);
    const owners = await safe.getOwners();
    if (Array.isArray(owners) && owners.length > 0) {
      process.stdout.write('safe-tx\n');
      return;
    }
  } catch (_) {}
  // Try Timelock.getMinDelay()
  try {
    const tl = new ethers.Contract(owner, TIMELOCK_ABI, p);
    const d = await tl.getMinDelay();
    if (d !== undefined) {
      process.stdout.write('proposal\n');
      return;
    }
  } catch (_) {}
  process.stdout.write('unknown\n');
}

main().catch(e => {
  console.error('ERR', e?.message || e);
  process.exit(1);
});
