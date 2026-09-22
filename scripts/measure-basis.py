"""Sample the oracle that tokenized-equity lending marks against, twice, and compare
it to the price the same asset is trading at on-chain right now.

The point of the two samples is the timestamp. While US markets are shut the feed keeps
advancing its `unix_timestamp` and `last_updated_slot` -- so every freshness check a
protocol can perform on-chain passes -- while the price it carries does not move.

Units. A Scope xStock entry prices one unscaled token (raw / 10^decimals). Jupiter's
price v3 `usdPrice` is per UI unit, which for a Token-2022 ScaledUiAmount mint is one
share: raw x multiplier. One token is therefore `multiplier` shares, and the two numbers
are compared like for like as

    oracle_per_share = scope_price / multiplier
    basis            = (dex - oracle_per_share) / oracle_per_share

The multiplier is read from each mint on every run, and it is the one in force at the
chain clock: `newMultiplier` once `newMultiplierEffectiveTimestamp` has passed, otherwise
`multiplier`. The `bare` column divides by nothing. It is how the first version of this
script compared them, and it is wrong by exactly the multiplier.

Usage:  SOLANA_RPC_URL=... python scripts/measure-basis.py [--gap 100] [--out FILE]
"""
import argparse, base64, datetime as dt, json, os, struct, time, urllib.request

SCOPE_PRICES = "3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
SCOPE_PROGRAM = "HFn8GnPADiny6XqUoWE8uRPPxb29ikn4yTuPa9MF2fWJ"
TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111"

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

# Token-2022 mint layout, as keeper/src/token2022.ts decodes it: the base mint padded to
# 165 bytes, a one-byte account type (1 = mint), then TLV entries of u16 type | u16 length.
ACCOUNT_TYPE_OFFSET = 165
ACCOUNT_TYPE_MINT = 1
TLV_START = ACCOUNT_TYPE_OFFSET + 1
EXT_SCALED_UI_AMOUNT = 25

BASIS_METHOD = ("like-for-like: oracle_price_per_share = oracle_price / multiplier; "
                "basis_bps = (dex_price - oracle_price_per_share) / oracle_price_per_share; "
                "basis_bps_bare = (dex_price - oracle_price) / oracle_price")

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


def scaled_ui_amount(raw):
    """`ScaledUiAmountConfig`, #[repr(C)]: authority(32) | multiplier f64 |
    new_multiplier_effective_timestamp i64 | new_multiplier f64, all little-endian.
    Returns None when the mint carries no such extension."""
    if len(raw) <= TLV_START or raw[ACCOUNT_TYPE_OFFSET] != ACCOUNT_TYPE_MINT:
        return None
    off = TLV_START
    while off + 4 <= len(raw):
        ext_type, length = struct.unpack_from("<HH", raw, off)
        if ext_type == 0 and length == 0:
            break
        if ext_type == EXT_SCALED_UI_AMOUNT and length >= 56:
            multiplier, effective_ts, new_multiplier = struct.unpack_from("<dqd", raw, off + 4 + 32)
            return {"multiplier": multiplier, "new_multiplier": new_multiplier, "effective_ts": effective_ts}
        off += 4 + length
    return None


def read_multipliers(url):
    """Each mint's multiplier in force at the chain clock, read in one call with the clock."""
    mints = [m for _s, m in FEEDS.values()]
    res = rpc(url, "getMultipleAccounts", [mints + [CLOCK_SYSVAR], {"encoding": "base64"}])["result"]
    accounts = res["value"]
    clock = accounts[-1]
    assert clock is not None, "Clock sysvar not returned"
    now = struct.unpack_from("<q", base64.b64decode(clock["data"][0]), 32)[0]
    out = {}
    for (sym, mint), acc in zip(FEEDS.values(), accounts[:-1]):
        assert acc is not None, f"{sym} mint {mint} not returned"
        assert acc["owner"] == TOKEN_2022, f"{sym} mint is owned by {acc['owner']}, not Token-2022"
        cfg = scaled_ui_amount(base64.b64decode(acc["data"][0]))
        if cfg is None:
            out[sym] = {"multiplier": 1.0, "pending": None}
            continue
        in_force = now >= cfg["effective_ts"]
        out[sym] = {
            "multiplier": cfg["new_multiplier"] if in_force else cfg["multiplier"],
            "pending": None if in_force else {"multiplier": cfg["new_multiplier"], "effective_ts": cfg["effective_ts"]},
        }
    return now, out


def read_dex():
    ids = ",".join(m for _s, m in FEEDS.values())
    req = urllib.request.Request(f"https://lite-api.jup.ag/price/v3?ids={ids}", headers=HDR)
    data = json.load(urllib.request.urlopen(req, timeout=30))
    return {sym: (data.get(mint) or {}).get("usdPrice") for sym, mint in
            ((s, m) for s, m in FEEDS.values())}


def cell(x, fmt, width):
    return format(x, fmt) if x is not None else "n/a".rjust(width)


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
    chain_now, mults = read_multipliers(url)

    taken = dt.datetime.now(dt.timezone.utc)
    clock = dt.datetime.fromtimestamp(chain_now, dt.timezone.utc)
    print(f"oracle  {SCOPE_PRICES}  (Kamino Scope OraclePrices: price per unscaled token)")
    print("market  lite-api.jup.ag/price/v3 usdPrice (price per share)")
    print(f"sampled {taken.strftime('%Y-%m-%d %H:%M:%S')}Z, {args.gap}s apart; "
          f"multipliers in force at chain clock {clock.strftime('%Y-%m-%d %H:%M:%S')}Z\n")
    print(f"{'':7s}{'ORACLE':>11s}{'moved':>9s}{'ts+':>5s}{'slot+':>6s} | "
          f"{'MULTIPLIER':>19s}{'PER SHARE':>11s}{'ON-CHAIN':>11s}{'basis':>9s}{'bare':>9s}")

    rows = []
    for sym in (s for s, _m in FEEDS.values()):
        a, b = first[sym], second[sym]
        d = dex_second.get(sym)
        m = mults[sym]["multiplier"]
        per_share = b["price"] / m
        basis_bps = (d - per_share) / per_share * 1e4 if d else None
        bare_bps = (d - b["price"]) / b["price"] * 1e4 if d else None
        rows.append({"symbol": sym, "oracle_price": b["price"],
                     "oracle_price_moved": round(b["price"] - a["price"], 10),
                     "oracle_ts_advanced_s": b["ts"] - a["ts"],
                     "oracle_slot_advanced": b["slot"] - a["slot"],
                     "oracle_reported_age_s": int(taken.timestamp()) - b["ts"],
                     "multiplier": m,
                     "multiplier_pending": mults[sym]["pending"],
                     "oracle_price_per_share": per_share,
                     "dex_price": d,
                     "basis_bps": round(basis_bps, 1) if basis_bps is not None else None,
                     "basis_bps_bare": round(bare_bps, 1) if bare_bps is not None else None})
        pending = mults[sym]["pending"]
        print(f"{sym:7s}{b['price']:11.4f}{b['price'] - a['price']:9.4f}"
              f"{b['ts'] - a['ts']:5d}{b['slot'] - a['slot']:6d} | "
              f"{repr(m):>19s}{per_share:11.4f}{cell(d, '11.4f', 11)}"
              f"{cell(basis_bps, '+9.1f', 9)}{cell(bare_bps, '+9.1f', 9)}"
              + (f"   pending -> {pending['multiplier']} at {pending['effective_ts']}" if pending else ""))

    print("\nbasis = (on-chain - oracle / multiplier) / (oracle / multiplier), in bps.")
    print("bare  = (on-chain - oracle) / oracle: mixed units, off by the multiplier. Shown so the correction is visible.")

    snap = {"taken_at": taken.isoformat(), "gap_seconds": args.gap,
            "oracle_account": SCOPE_PRICES, "oracle_program": SCOPE_PROGRAM,
            "dex_price_source": "jup.ag price v3", "multiplier_clock_unix": chain_now,
            "basis_method": BASIS_METHOD, "rows": rows}
    if args.out:
        with open(args.out, "w") as fh:
            json.dump(snap, fh, indent=2)
        print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
