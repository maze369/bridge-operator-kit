#!/usr/bin/env node
// Bridge health + honesty checker.
//
// Reads ONLY public RPCs + the shared addresses.yaml in this repo. Verifies
// that what's on-chain matches what the bridge claims about itself. Runnable
// by anyone in the world, against any RPC, with no operator cooperation.
//
// Run before trusting the bridge with material value. Run periodically
// thereafter — anything that drifts is a red flag.
//
// Phase awareness: per-chain `owner` field selects the expected admin model.
//   owner: "operator-key"  → routers must be owned by a non-zero EOA;
//                            multisig fields are optional and skipped.
//   owner: "multisig"      → routers must be owned by the declared multisig,
//                            and the multisig is verified to have the
//                            declared signer set + threshold on chain.
//
// Usage:
//   node verify_bridge_health.mjs
//   node verify_bridge_health.mjs --chain <chain-key>   (single chain)
//   node verify_bridge_health.mjs --verbose
//
// Exit code 0 = all green. 1 = at least one check failed (see stderr).

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, Contract, ZeroAddress } from "ethers";
import { parse as parseYaml } from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KIT_ROOT = path.resolve(__dirname, "..");
const CHAINS_DIR = path.join(KIT_ROOT, "chains");
const ADDR_YAML = path.join(KIT_ROOT, "shared", "addresses.yaml");

const argv = process.argv.slice(2);
const VERBOSE = argv.includes("--verbose") || argv.includes("-v");

function parseChain(a) {
  const kv = a.find(x => x.startsWith("--chain="));
  if (kv) return kv.split("=")[1];
  const idx = a.indexOf("--chain");
  if (idx >= 0 && idx + 1 < a.length) return a[idx + 1];
  return null;
}
const ONLY_CHAIN = parseChain(argv);

// Merge chain.yaml (preset facts) + addresses.yaml (live cross-chain state).
function loadChains() {
  const presets = {};
  if (existsSync(CHAINS_DIR)) {
    for (const e of readdirSync(CHAINS_DIR, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith("_") || e.name.startsWith(".")) continue;
      const yp = path.join(CHAINS_DIR, e.name, "chain.yaml");
      if (!existsSync(yp)) continue;
      const c = parseYaml(readFileSync(yp, "utf8"));
      if (c && c.key) presets[c.key] = c;
    }
  }
  const addrs = existsSync(ADDR_YAML) ? parseYaml(readFileSync(ADDR_YAML, "utf8")) : {};
  const merged = {};
  // Every chain with a preset gets included (even if addresses.yaml hasn't
  // registered it yet — e.g. for verifying a freshly added chain.yaml on PR).
  for (const [k, preset] of Object.entries(presets)) {
    const state = addrs.chains?.[k] || {};
    merged[k] = {
      rpcUrls: preset.rpcUrls || [],
      mailbox: preset.hyperlane?.mailbox || "",
      merkleTreeHook: preset.hyperlane?.merkleTreeHook || "",
      validatorAnnounce: preset.hyperlane?.validatorAnnounce || "",
      ism: state.ism || "",
      ismValidators: state.ismValidators || [],
      ismThreshold: state.ismThreshold || 0,
      owner: state.owner || "operator-key",
      multisig: state.multisig || "",
      multisigOwners: state.multisigOwners || [],
      multisigThreshold: state.multisigThreshold,
      routers: state.routers || {},
    };
  }
  return merged;
}
const chainsMerged = loadChains();
const addresses = { chains: chainsMerged };

const OWNABLE_ABI = ["function owner() view returns (address)"];
// StaticMessageIdMultisigIsm (CREATE2 + MetaProxy) exposes a single
// view `validatorsAndThreshold(bytes)` that returns both arrays.
// The `bytes` parameter is the message (unused — the immutable metadata
// is identical for any input).
const ISM_ABI = [
  "function validatorsAndThreshold(bytes) view returns (address[], uint8)",
];
const ROUTER_ABI = [
  "function owner() view returns (address)",
  "function interchainSecurityModule() view returns (address)",
];
const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
];

let failed = 0;
const fail = (msg) => { console.error(`  FAIL: ${msg}`); failed++; };
const ok = (msg) => { if (VERBOSE) console.log(`  OK:   ${msg}`); };
const note = (msg) => console.log(`  NOTE: ${msg}`);

function ownerMode(ch) {
  // Backwards-compatible: if `owner` is "multisig" or a 0x address, treat as
  // multisig phase. Anything else (default: "operator-key") = Phase 1.
  const v = (ch.owner || "operator-key").toLowerCase();
  if (v === "multisig") return "multisig";
  if (v.startsWith("0x") && v !== ZeroAddress.toLowerCase()) return "multisig";
  return "operator-key";
}

// Try each declared RPC in order until one responds; return the first
// that successfully reports a block number.
async function pickProvider(rpcUrls) {
  for (const url of rpcUrls || []) {
    try {
      const p = new JsonRpcProvider(url);
      await p.getBlockNumber();   // probe
      return { p, url };
    } catch (e) {
      console.error(`  (skipping RPC ${url}: ${e.shortMessage || e.message || e.code})`);
    }
  }
  return null;
}

async function checkChain(chainKey, ch) {
  console.log(`\n=== ${chainKey} ===`);
  const picked = await pickProvider(ch.rpcUrls);
  if (!picked) { fail(`no working RPC in ${(ch.rpcUrls || []).join(", ") || "(empty)"}`); return; }
  console.log(`  RPC: ${picked.url}`);
  console.log(`  Mailbox: ${ch.mailbox}`);
  const mode = ownerMode(ch);
  console.log(`  Admin mode: ${mode}`);

  const provider = picked.p;

  // 1. Mailbox code exists and is non-empty (= contract deployed).
  const mailboxCode = await provider.getCode(ch.mailbox);
  if (mailboxCode === "0x") { fail(`Mailbox ${ch.mailbox} has no code`); return; }
  ok(`Mailbox deployed (${mailboxCode.length / 2 - 1} bytes)`);

  // 2. ValidatorAnnounce + MerkleTreeHook exist.
  if (ch.merkleTreeHook) {
    const c = await provider.getCode(ch.merkleTreeHook);
    if (c === "0x") fail(`MerkleTreeHook ${ch.merkleTreeHook} has no code`);
    else ok(`MerkleTreeHook deployed`);
  }
  if (ch.validatorAnnounce) {
    const c = await provider.getCode(ch.validatorAnnounce);
    if (c === "0x") fail(`ValidatorAnnounce ${ch.validatorAnnounce} has no code`);
    else ok(`ValidatorAnnounce deployed`);
  }

  // 3. ISM validators + threshold match declared.
  if (ch.ism) {
    try {
      const ism = new Contract(ch.ism, ISM_ABI, provider);
      // Pass an empty bytes message — MetaProxy ignores it.
      const [chainValidators, chainThreshold] = await ism.validatorsAndThreshold("0x");
      const declared = (ch.ismValidators || []).map(a => a.toLowerCase()).sort();
      const onchain = chainValidators.map(a => a.toLowerCase()).sort();
      if (JSON.stringify(declared) !== JSON.stringify(onchain)) {
        fail(`ISM validator set mismatch.\n    declared: ${declared.join(", ")}\n    on-chain: ${onchain.join(", ")}`);
      } else {
        ok(`ISM validators match (${onchain.length} validators)`);
      }
      if (BigInt(chainThreshold) !== BigInt(ch.ismThreshold)) {
        fail(`ISM threshold mismatch: declared=${ch.ismThreshold}, on-chain=${chainThreshold}`);
      } else {
        ok(`ISM threshold = ${chainThreshold}`);
      }
    } catch (e) {
      fail(`ISM read failed: ${e.shortMessage || e.message}`);
    }
  }

  // 4. Routers: owner expectation depends on phase.
  for (const [tok, rt] of Object.entries(ch.routers || {})) {
    try {
      const r = new Contract(rt.address, ROUTER_ABI, provider);
      const [owner, ism] = await Promise.all([r.owner(), r.interchainSecurityModule()]);
      if (mode === "multisig") {
        const ms = (ch.multisig || "").toLowerCase();
        if (owner.toLowerCase() !== ms) {
          fail(`Router ${tok} owner is ${owner}, expected multisig ${ch.multisig}`);
        } else {
          ok(`Router ${tok} owner = multisig`);
        }
      } else {
        // Phase 1: just confirm a non-zero EOA owns it. Drift detection only
        // makes sense once a target is published (multisig phase).
        if (!owner || owner === ZeroAddress) {
          fail(`Router ${tok} owner is zero address`);
        } else {
          ok(`Router ${tok} owner = ${owner} (operator-key phase)`);
        }
      }
      if (ch.ism && ism.toLowerCase() !== (ch.ism || "").toLowerCase()) {
        fail(`Router ${tok} ISM is ${ism}, expected ${ch.ism}`);
      } else if (ch.ism) {
        ok(`Router ${tok} ISM matches declared`);
      }
    } catch (e) {
      fail(`Router ${tok} (${rt.address}) read failed: ${e.shortMessage || e.message}`);
    }
  }

  // 5. Multisig: only checked when in multisig mode.
  if (mode === "multisig") {
    if (!ch.multisig || ch.multisig === ZeroAddress) {
      fail(`Admin mode is multisig but ch.multisig is unset/zero — set it in addresses.yaml`);
    } else {
      try {
        const safe = new Contract(ch.multisig, SAFE_ABI, provider);
        const [owners, thresh] = await Promise.all([safe.getOwners(), safe.getThreshold()]);
        const declared = (ch.multisigOwners || []).map(a => a.toLowerCase()).sort();
        const onchain = owners.map(a => a.toLowerCase()).sort();
        if (declared.length === 0) {
          note(`multisigOwners not declared in addresses.yaml — on-chain set: ${onchain.join(", ")}`);
        } else if (JSON.stringify(declared) !== JSON.stringify(onchain)) {
          fail(`Multisig signers mismatch.\n    declared: ${declared.join(", ")}\n    on-chain: ${onchain.join(", ")}`);
        } else {
          ok(`Multisig signers match (${owners.length})`);
        }
        if (ch.multisigThreshold == null) {
          note(`multisigThreshold not declared — on-chain: ${thresh}`);
        } else if (BigInt(thresh) !== BigInt(ch.multisigThreshold)) {
          fail(`Multisig threshold mismatch: declared=${ch.multisigThreshold}, on-chain=${thresh}`);
        } else {
          ok(`Multisig threshold = ${thresh}`);
        }
      } catch (e) {
        fail(`Multisig read failed (is ${ch.multisig} actually a Gnosis Safe?): ${e.shortMessage || e.message}`);
      }
    }
  } else {
    note(`Skipping multisig checks — chain is in operator-key phase (set owner: multisig to enable)`);
  }
}

async function main() {
  console.log(`Bridge health check @ ${new Date().toISOString()}`);
  console.log(`Source of truth: shared/addresses.yaml`);

  const chains = Object.entries(addresses.chains || {});
  if (chains.length === 0) {
    console.error("No chains in addresses.yaml.");
    process.exit(2);
  }

  for (const [k, ch] of chains) {
    if (ONLY_CHAIN && k !== ONLY_CHAIN) continue;
    try {
      await checkChain(k, ch);
    } catch (e) {
      // A chain-level fault (RPC dead, contract uncallable, etc.) shouldn't
      // tank the rest of the run. Log and keep going so the operator gets
      // a complete picture.
      fail(`${k}: unexpected error: ${e.shortMessage || e.message || e}`);
    }
  }

  console.log(`\n${failed === 0 ? "ALL GREEN" : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(e => {
  console.error("FATAL:", e);
  process.exit(3);
});
