"""Sample the oracle that tokenized-equity lending marks against, twice, and compare
it to the price the same asset is trading at on-chain right now.

The point of the two samples is the timestamp. While US markets are shut the feed keeps
advancing its `unix_timestamp` and `last_updated_slot` -- so every freshness check a
protocol can perform on-chain passes -- while the price it carries does not move.

Usage:  SOLANA_RPC_URL=... python scripts/measure-basis.py [--gap 100] [--out FILE]
"""
import argparse, base64, datetime as dt, json, os, struct, time, urllib.request

SCOPE_PRICES = "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
SCOPE_PROGRAM = "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ"

# Scope slot index -> (symbol, xStock mint). Slots cross-checked against the Kamino
# klend reserve configs that consume them.
FEEDS = {
    317: ("AAPLx", "XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp"),
    332: ("NVDAx", "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh"),
    342: ("SPYx",  "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W"),
    345: ("QQQx",  "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ"),
    327: ("METAx", "Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu"),
    323: ("CRCLx", "XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1"),
    320: ("HOODx", "XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg"),
    341: ("COINx", "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu"),
}

HDR = {"User-Agent": "deliverable/measure-basis", "Accept": "application/json"}


def rpc(url, method, params):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=60))


def read_oracle(url):
    """Decode Scope OraclePrices. Layout: disc(8) + oracle_mappings(32) + DatedPrice[512],
    each 56 bytes: value u64 | exp u64 | last_updated_slot u64 | unix_timestamp u64 | _[24]."""
    info = rpc(url, "getAccountInfo", [SCOPE_PRICES, {"encoding": "base64"}])["result"]["value"]
    assert info["owner"] == SCOPE_PROGRAM, f"unexpected owner {info['owner']}"
    raw = base64.b64decode(info["data"][0])
    out = {}
    for idx, (sym, _mint) in FEEDS.items():
        value, exp, upd_slot, ts = struct.unpack_from("<QQQQ", raw, 40 + idx * 56)
        out[sym] = {"price": value / (10 ** exp), "slot": upd_slot, "ts": ts}
    return out


def read_dex():
    ids = ",".join(m for _s, m in FEEDS.values())
    req = urllib.request.Request(f"https://lite-api.jup.ag/price/v3?ids={ids}", headers=HDR)
    data = json.load(urllib.request.urlopen(req, timeout=30))
    return {sym: (data.get(mint) or {}).get("usdPrice") for sym, mint in
            ((s, m) for s, m in FEEDS.values())}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gap", type=int, default=100, help="seconds between the two samples")
    ap.add_argument("--out", default=None, help="write the snapshot as JSON")
    args = ap.parse_args()

    url = os.environ.get("SOLANA_RPC_URL")
    if not url:
        raise SystemExit("set SOLANA_RPC_URL (the public endpoint rate-limits this)")

    first, dex_first = read_oracle(url), read_dex()
    time.sleep(args.gap)
    second, dex_second = read_oracle(url), read_dex()

    taken = dt.datetime.now(dt.timezone.utc)
    print(f"oracle  {SCOPE_PRICES}  (Kamino Scope, Chainlink-sourced)")
    print(f"sampled {taken.strftime('%Y-%m-%d %H:%M:%S')}Z, {args.gap}s apart\n")
    print(f"{'':8s}{'ORACLE':>12s}{'moved':>9s}{'ts+':>6s}{'slot+':>7s} | {'ON-CHAIN':>11s}{'basis':>9s}")

    rows = []
    for sym in (s for s, _m in FEEDS.values()):
        a, b = first[sym], second[sym]
        d = dex_second.get(sym)
        basis_bps = (d - b["price"]) / b["price"] * 1e4 if d else None
        rows.append({"symbol": sym, "oracle_price": b["price"],
                     "oracle_price_moved": round(b["price"] - a["price"], 10),
                     "oracle_ts_advanced_s": b["ts"] - a["ts"],
                     "oracle_slot_advanced": b["slot"] - a["slot"],
                     "oracle_reported_age_s": int(taken.timestamp()) - b["ts"],
                     "dex_price": d, "basis_bps": round(basis_bps, 1) if basis_bps else None})
        print(f"{sym:8s}{b['price']:12.4f}{b['price']-a['price']:9.4f}"
              f"{b['ts']-a['ts']:6d}{b['slot']-a['slot']:7d} | "
              f"{(d or 0):11.4f}{(basis_bps or 0):+8.1f}b")

    snap = {"taken_at": taken.isoformat(), "gap_seconds": args.gap,
            "oracle_account": SCOPE_PRICES, "oracle_program": SCOPE_PROGRAM,
            "dex_price_source": "jup.ag price v3", "rows": rows}
    if args.out:
        with open(args.out, "w") as fh:
            json.dump(snap, fh, indent=2)
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
