#!/usr/bin/env node
// build_proposal.mjs — Phase 3 helper. Emits an OpenZeppelin Governor-
// compatible proposal payload for `router.setInterchainSecurityModule(newIsm)`.
//
// The output is the (targets, values, calldatas, description) tuple the
// DAO frontend uses to call `Governor.propose()`. After the vote passes
// and the Timelock delay elapses, anyone can call `Governor.execute()`
// with the same tuple — at which point the Timelock invokes the router.
//
// Usage:
//   ROUTER=<0x...> ISM=<0x...> [DESCRIPTION="..."] \
//     node build_proposal.mjs > proposal.json
//
// Multiple targets in one proposal (e.g., swap ISM on 4 routers at once):
//   ROUTERS=0xa,0xb,0xc ISM=0x... node build_proposal.mjs
//
// Output schema:
//   {
//     "targets":   ["0xRouter1", "0xRouter2", ...],
//     "values":    ["0", "0", ...],
//     "calldatas": ["0x...", "0x...", ...],
//     "description": "...",
//     "descriptionHash": "0x...",
//     "proposalId": "<bigint as string>"
//   }
//
// The DAO frontend can paste targets/values/calldatas/description directly
// into a propose() call. proposalId is derived deterministically so anyone
// can verify the same bytes execute the same change.

import { ethers } from 'ethers';

const ISM = process.env.ISM;
let routers;
if (process.env.ROUTERS) {
  routers = process.env.ROUTERS.split(',').map(s => s.trim());
} else if (process.env.ROUTER) {
  routers = [process.env.ROUTER];
}
if (!ISM || !routers || routers.length === 0) {
  console.error('FATAL set ISM=<0x...> and ROUTER=<0x...> (or ROUTERS=0xa,0xb,...)');
  process.exit(2);
}
const desc = process.env.DESCRIPTION ||
  `Update interchainSecurityModule to ${ISM} on ${routers.length} router(s) — automated by promote_operator.sh`;

const iface = new ethers.utils.Interface([
  'function setInterchainSecurityModule(address)',
]);
const calldata = iface.encodeFunctionData('setInterchainSecurityModule', [ISM]);

const calldatas = routers.map(() => calldata);
const values = routers.map(() => '0');

// Governor `hashProposal` = keccak256(abi.encode(targets, values, calldatas, descriptionHash))
const descHash = ethers.utils.id(desc);  // keccak256 of description
const proposalIdBytes = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
  ['address[]', 'uint256[]', 'bytes[]', 'bytes32'],
  [routers, values.map(v => v), calldatas, descHash],
));
const proposalId = ethers.BigNumber.from(proposalIdBytes).toString();

const out = {
  targets: routers,
  values,
  calldatas,
  description: desc,
  descriptionHash: descHash,
  proposalId,
};
process.stdout.write(JSON.stringify(out, null, 2) + '\n');
