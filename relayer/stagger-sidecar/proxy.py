"""Stagger sidecar — race-condition gate for multi-relayer setups.

Intercepts JSON-RPC calls from the Hyperlane relayer to the destination
chain's RPC. Specifically:

  - eth_sendRawTransaction calls are HELD for RELAYER_DELAY_MS, then before
    forwarding, the sidecar parses the signed tx to extract (to, data, value)
    and runs an eth_call to simulate the tx against current head state.
    If the simulation reverts (the common case for already-delivered
    Mailbox.process() — Mailbox short-circuits when delivered[mid] is set),
    the call returns a synthetic "already delivered" error and the tx is
    NEVER actually broadcast. If the simulation succeeds, the tx is
    forwarded.

  - All other RPC calls are forwarded verbatim with no delay.

Effect: when 2+ relayers compete for the same message, only the lowest-delay
relayer's tx lands. Higher-delay relayers see the simulation revert and skip.
Steady-state cost: primary relayer pays ~all gas; spares pay near zero.

Routes per chain are loaded from /config/agent-config.json. The Hyperlane
relayer must be configured to talk to this sidecar at
  http://stagger-sidecar:8545/<chain-key>
The sidecar then forwards to that chain's real upstream RPC.

Implementation: aiohttp server + eth-account for signed-tx decoding.
~200 LOC. Pure async; one delay-coroutine per pending tx.
"""

import asyncio
import json
import logging
import os
from pathlib import Path

import aiohttp
from aiohttp import web

LOG = logging.getLogger("stagger")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")

DELAY_MS = int(os.environ.get("RELAYER_DELAY_MS", "15000"))
AGENT_CONFIG = os.environ.get("AGENT_CONFIG", "/config/agent-config.json")


def load_chains():
    """Map chain key → {rpc, mailbox} from agent-config.json."""
    cfg = json.loads(Path(AGENT_CONFIG).read_text())
    out = {}
    for k, ch in cfg.get("chains", {}).items():
        rpcs = ch.get("rpcUrls", [])
        rpc = rpcs[0].get("http") if rpcs else None
        out[k] = {"rpc": rpc, "mailbox": (ch.get("mailbox", "") or "").lower()}
    return out


# ─── Minimal RLP decoder (legacy + EIP-1559/2930 typed txs) ────────────
# Avoids depending on eth-account / web3.py just for raw-tx parsing.
#
# RLP grammar:
#   0x00–0x7f         single byte literal
#   0x80–0xb7         short string (length = byte - 0x80)
#   0xb8–0xbf         long  string (length-prefix follows)
#   0xc0–0xf7         short list  (payload length = byte - 0xc0)
#   0xf8–0xff         long  list  (length-prefix follows)

def _rlp_decode(buf: bytes, i: int = 0):
    """Return (decoded, next_index). decoded is bytes or list of items."""
    b = buf[i]
    if b < 0x80:
        return buf[i:i + 1], i + 1
    if b < 0xb8:
        n = b - 0x80
        return buf[i + 1:i + 1 + n], i + 1 + n
    if b < 0xc0:
        ln = b - 0xb7
        n = int.from_bytes(buf[i + 1:i + 1 + ln], "big")
        start = i + 1 + ln
        return buf[start:start + n], start + n
    if b < 0xf8:
        n = b - 0xc0
        end = i + 1 + n
        items, j = [], i + 1
        while j < end:
            item, j = _rlp_decode(buf, j)
            items.append(item)
        return items, end
    ln = b - 0xf7
    n = int.from_bytes(buf[i + 1:i + 1 + ln], "big")
    end = i + 1 + ln + n
    items, j = [], i + 1 + ln
    while j < end:
        item, j = _rlp_decode(buf, j)
        items.append(item)
    return items, end


def _b2i(b: bytes) -> int:
    return int.from_bytes(b or b"\x00", "big")


def parse_signed_tx(raw_hex: str):
    """Parse a signed legacy / EIP-2930 / EIP-1559 tx into the dict shape
    eth_call expects: {to, data, value, gas}.

    No sender recovery (eth_call doesn't require `from`; gas/balance
    checks aren't relevant when the agent has already pre-checked).

    Field layouts (canonical RLP):
      Legacy:   [nonce, gasPrice, gas, to, value, data, v, r, s]
      EIP-2930: 0x01 || [chainId, nonce, gasPrice, gas, to, value, data, accessList, v, r, s]
      EIP-1559: 0x02 || [chainId, nonce, maxPriority, maxFee, gas, to, value, data, accessList, v, r, s]
    """
    h = raw_hex[2:] if raw_hex.startswith("0x") else raw_hex
    raw = bytes.fromhex(h)
    if not raw:
        raise ValueError("empty raw tx")

    type_tag = raw[0]
    if type_tag >= 0xc0:
        items, _ = _rlp_decode(raw, 0)
        # Legacy: [nonce, gasPrice, gas, to, value, data, v, r, s]
        _nonce, _gp, gas, to, value, data = items[0:6]
    elif type_tag == 0x01:
        items, _ = _rlp_decode(raw, 1)
        # EIP-2930: [chainId, nonce, gasPrice, gas, to, value, data, ...]
        _cid, _nonce, _gp, gas, to, value, data = items[0:7]
    elif type_tag == 0x02:
        items, _ = _rlp_decode(raw, 1)
        # EIP-1559: [chainId, nonce, maxPriority, maxFee, gas, to, value, data, ...]
        _cid, _nonce, _mp, _mf, gas, to, value, data = items[0:8]
    else:
        raise ValueError(f"unknown tx type {hex(type_tag)}")

    to_hex = ("0x" + to.hex()) if isinstance(to, (bytes, bytearray)) and len(to) > 0 else None
    if to_hex is None:
        raise ValueError("contract-creation tx has no `to` — not a process() call")

    return {
        "to": to_hex,
        "data": "0x" + data.hex() if data else "0x",
        "value": hex(_b2i(value)),
        "gas": hex(_b2i(gas)) if gas else "0x500000",
    }


async def simulate_delivery(session, rpc_url: str, raw_tx_hex: str):
    """Return True if the tx WOULD revert (treat as already-delivered / skip).
    Return False if the tx WOULD succeed (forward it).

    On parse / RPC errors, return False — the safe fallback is to forward and
    let the chain be authoritative.
    """
    try:
        call = parse_signed_tx(raw_tx_hex)
    except Exception as e:
        LOG.warning("parse_signed_tx failed: %s — forwarding", e)
        return False

    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_call",
        "params": [
            {
                "to": call["to"],
                "data": call["data"],
                "value": call["value"],
                "gas": call["gas"],
                **({"from": call["from"]} if "from" in call else {}),
            },
            "latest",
        ],
    }
    try:
        async with session.post(rpc_url, json=payload, timeout=aiohttp.ClientTimeout(total=15)) as r:
            j = await r.json()
            if "error" in j:
                msg = (j["error"].get("message") or "").lower()
                # Any revert at simulation time = the tx would revert if
                # broadcast right now. The most common cause for a relayer's
                # process() to revert is delivered[mid] == true. Less common
                # causes (gas, nonce, signer) would revert the real tx anyway.
                LOG.info("simulate revert: %s — skipping broadcast", msg[:200])
                return True
            return False
    except Exception as e:
        LOG.warning("simulate RPC error: %s — forwarding", e)
        return False


async def handle_rpc(request: web.Request):
    """Main JSON-RPC entry point. Path = /<chain_key>."""
    chain_key = request.match_info.get("chain")
    chains = request.app["chains"]
    if chain_key not in chains:
        return web.json_response(
            {"jsonrpc": "2.0", "error": {"code": -32602, "message": f"unknown chain {chain_key}"}, "id": None},
            status=400,
        )
    rpc_url = chains[chain_key]["rpc"]
    if not rpc_url:
        return web.json_response(
            {"jsonrpc": "2.0", "error": {"code": -32603, "message": f"no rpc for chain {chain_key}"}, "id": None},
            status=500,
        )
    body = await request.json()

    is_batch = isinstance(body, list)
    items = body if is_batch else [body]
    out = []

    async with aiohttp.ClientSession() as session:
        for item in items:
            method = item.get("method", "")

            if method == "eth_sendRawTransaction":
                LOG.info("[%s] holding tx for %d ms", chain_key, DELAY_MS)
                await asyncio.sleep(DELAY_MS / 1000.0)

                raw = (item.get("params") or [None])[0]
                if raw and await simulate_delivery(session, rpc_url, raw):
                    LOG.info("[%s] skipping — simulation reverts (already delivered or otherwise stale)", chain_key)
                    out.append({
                        "jsonrpc": "2.0",
                        "id": item.get("id"),
                        "error": {"code": -32000, "message": "skipped: simulation reverts (stagger sidecar)"},
                    })
                    continue

                async with session.post(rpc_url, json=item, timeout=aiohttp.ClientTimeout(total=30)) as r:
                    out.append(await r.json())
            else:
                async with session.post(rpc_url, json=item, timeout=aiohttp.ClientTimeout(total=30)) as r:
                    out.append(await r.json())

    return web.json_response(out if is_batch else out[0])


async def healthz(request):
    return web.json_response({
        "status": "ok",
        "delay_ms": DELAY_MS,
        "chains": list(request.app["chains"].keys()),
    })


def main():
    chains = load_chains()
    LOG.info("loaded chains: %s", list(chains.keys()))
    LOG.info("delay: %d ms", DELAY_MS)
    app = web.Application()
    app["chains"] = chains
    app.router.add_get("/healthz", healthz)
    app.router.add_post("/{chain}", handle_rpc)
    web.run_app(app, host="0.0.0.0", port=8545)


if __name__ == "__main__":
    main()
