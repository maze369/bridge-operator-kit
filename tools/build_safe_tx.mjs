#!/usr/bin/env node
// build_safe_tx.mjs — Phase 2 helper. Emits a Gnosis Safe-compatible
// transaction JSON for `router.setInterchainSecurityModule(newIsm)`.
//
// The admin imports the resulting JSON into the Safe Transaction Builder
// (or pastes via the Safe SDK CLI), collects M-of-N signatures, then
// the Safe executes the call.
//
// Usage:
//   ROUTER=<0x...> ISM=<0x...> SAFE=<0x...> CHAIN_ID=<n> \
//     node build_safe_tx.mjs > safe_tx.json
//
// Output schema matches the "Transaction Builder" import format:
//   {
//     "version": "1.0",
//     "chainId": "766",
//     "createdAt": <unix-ms>,
//     "meta": { "name": "...", "description": "..." },
//     "transactions": [
//       { "to": router, "value": "0", "data": "0x...", "operation": 0 }
//     ]
//   }

import { ethers } from 'ethers';

const ROUTER = process.env.ROUTER;
const ISM = process.env.ISM;
const SAFE = process.env.SAFE;
const CHAIN_ID = process.env.CHAIN_ID;
if (!ROUTER || !ISM || !SAFE || !CHAIN_ID) {
  console.error('FATAL set ROUTER, ISM, SAFE, CHAIN_ID');
  process.exit(2);
}

// ethers v6 namespace (v5 used ethers.utils.Interface).
const iface = new ethers.Interface([
  'function setInterchainSecurityModule(address)',
]);
const data = iface.encodeFunctionData('setInterchainSecurityModule', [ISM]);

const payload = {
  version: '1.0',
  chainId: String(CHAIN_ID),
  createdAt: Date.now(),
  meta: {
    name: `setInterchainSecurityModule(${ISM}) on router ${ROUTER}`,
    description: `Phase 2 admin tx — swap router ISM. Signed by Safe ${SAFE}.`,
    txBuilderVersion: '1.18.0',
    createdFromSafeAddress: SAFE,
  },
  transactions: [
    {
      to: ROUTER,
      value: '0',
      data,
      contractMethod: {
        inputs: [{ name: '_module', type: 'address' }],
        name: 'setInterchainSecurityModule',
        payable: false,
      },
      contractInputsValues: { _module: ISM },
    },
  ],
};

process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
