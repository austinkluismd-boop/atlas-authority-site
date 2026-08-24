#!/usr/bin/env python3
"""Build command/feed.json — the Atlas Command live feed.

Runs hourly via .github/workflows/command-feed.yml (and by hand). Merges:

  1. Committed seeds (command/data/*.json) — the frozen point-0 baseline
     index, the ops/permission queue, engine coverage, priorities, geogrid.
  2. Live pulls, WHEN the credential exists:
       SEMRUSH_API_KEY   -> api.semrush.com domain_ranks  (provenance: estimate)
       CRUX_PSI_API_KEY  -> Chrome UX Report API field p75s (provenance: measurement)
     A missing credential renders as state "awaiting_credential" — the page
     shows the gap and the unlock. A failed pull renders as "error" with the
     reason. Nothing is ever fabricated, interpolated, or forward-filled.
  3. command/data/history.jsonl — APPEND-ONLY pull history. Every successful
     live pull appends one line; the feed embeds the recent window so the
     console accumulates a real hourly series over time. This file is never
     rewritten or truncated by this script.

Provenance law (inherited from the estate's consoles): a figure may render as
MEASURED only when its provenance is "measurement". Semrush is a vendor model
of the practice — always "estimate". The two never merge into one line.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
import urllib.parse
import datetime as dt
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE / "data"
FEED = HERE / "feed.json"
HISTORY = DATA / "history.jsonl"

SCHEMA = "atlas-command-feed-v1"
UA = "atlas-command-feed/1.0 (+https://www.atlas-authority.com/command/)"

TENANTS = {
    "tsa-cuzalina": {"domain": "tulsasurgicalarts.com", "origin": "https://tulsasurgicalarts.com"},
    "osa": {"domain": "oklahomasurgicalarts.com", "origin": "https://oklahomasurgicalarts.com"},
}


def _now() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


def _read(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _http(url: str, payload: dict | None = None, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, data=data, timeout=timeout) as r:
        return r.read()


def _append_history(rows: list[dict]) -> None:
    """Append-only. One JSON line per observation. Never rewrites."""
    if not rows:
        return
    with HISTORY.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, separators=(",", ":")) + "\n")


def _recent_history(max_rows: int = 2000) -> list[dict]:
    if not HISTORY.is_file():
        return []
    rows = []
    for line in HISTORY.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except ValueError:
            continue  # a torn line is skipped, never repaired in place
    return rows[-max_rows:]


def pull_semrush(key: str) -> dict:
    """Semrush classic API domain_ranks per tenant. Provenance: estimate."""
    out = {"state": "ok", "provenance": "estimate",
           "source": "Semrush API (domain_ranks, database=us)", "tenants": {}}
    cols = "Dn,Rk,Or,Ot,Oc,Ad,At,Ac"
    for slug, t in TENANTS.items():
        url = ("https://api.semrush.com/?" + urllib.parse.urlencode({
            "type": "domain_ranks", "key": key, "domain": t["domain"],
            "database": "us", "export_columns": cols}))
        try:
            body = _http(url).decode("utf-8", "replace").strip()
        except Exception as e:  # noqa: BLE001 — any failure is reported, not raised
            out["tenants"][slug] = {"state": "error", "reason": str(e)[:200]}
            continue
        lines = body.splitlines()
        if len(lines) < 2 or "ERROR" in lines[0]:
            out["tenants"][slug] = {"state": "error", "reason": body[:200]}
            continue
        vals = lines[1].split(";")
        keys = lines[0].split(";")
        row = dict(zip(keys, vals))
        out["tenants"][slug] = {
            "state": "ok",
            "rank": _int(row.get("Rank") or row.get("Rk")),
            "organic_keywords": _int(row.get("Organic Keywords") or row.get("Or")),
            "organic_traffic": _int(row.get("Organic Traffic") or row.get("Ot")),
            "organic_cost_usd": _int(row.get("Organic Cost") or row.get("Oc")),
            "adwords_keywords": _int(row.get("Adwords Keywords") or row.get("Ad")),
            "captured_at": _now(),
        }
    return out


def pull_crux(key: str) -> dict:
    """CrUX API origin-level p75s. Provenance: measurement (field data)."""
    out = {"state": "ok", "provenance": "measurement",
           "source": "Chrome UX Report API (origin, p75, field)", "tenants": {}}
    url = f"https://chromeuxreport.googleapis.com/v1/records:queryRecord?key={urllib.parse.quote(key)}"
    for slug, t in TENANTS.items():
        try:
            body = json.loads(_http(url, {"origin": t["origin"]}).decode("utf-8"))
            m = body.get("record", {}).get("metrics", {})

            def p75(name):
                v = m.get(name, {}).get("percentiles", {}).get("p75")
                return float(v) if v is not None else None

            out["tenants"][slug] = {
                "state": "ok",
                "lcp_p75_ms": p75("largest_contentful_paint"),
                "inp_p75_ms": p75("interaction_to_next_paint"),
                "cls_p75": p75("cumulative_layout_shift"),
                "ttfb_p75_ms": p75("experimental_time_to_first_byte"),
                "captured_at": _now(),
            }
        except Exception as e:  # noqa: BLE001
            out["tenants"][slug] = {"state": "error", "reason": str(e)[:200]}
    return out


def _int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return None


def main() -> int:
    generated_at = _now()
    live = {}
    history_rows = []

    sem_key = os.environ.get("SEMRUSH_API_KEY", "").strip()
    if sem_key:
        sem = pull_semrush(sem_key)
        live["semrush"] = sem
        for slug, row in sem["tenants"].items():
            if row.get("state") == "ok":
                for metric, val in (("semrush.rank", row["rank"]),
                                    ("semrush.organic.kw", row["organic_keywords"]),
                                    ("semrush.organic.traffic", row["organic_traffic"]),
                                    ("semrush.organic.traffic_cost_usd", row["organic_cost_usd"])):
                    if val is not None:
                        history_rows.append({"t": row["captured_at"], "tenant": slug,
                                             "metric": metric, "v": val,
                                             "provenance": "estimate"})
    else:
        live["semrush"] = {"state": "awaiting_credential",
                           "unlock": "Add the SEMRUSH_API_KEY repository secret (OPS-22: Semrush API entitlement)."}

    crux_key = os.environ.get("CRUX_PSI_API_KEY", "").strip()
    if crux_key:
        crux = pull_crux(crux_key)
        live["crux"] = crux
        for slug, row in crux["tenants"].items():
            if row.get("state") == "ok":
                for metric, val in (("crux.lcp_p75_ms", row["lcp_p75_ms"]),
                                    ("crux.inp_p75_ms", row["inp_p75_ms"]),
                                    ("crux.cls_p75", row["cls_p75"]),
                                    ("crux.ttfb_p75_ms", row["ttfb_p75_ms"])):
                    if val is not None:
                        history_rows.append({"t": row["captured_at"], "tenant": slug,
                                             "metric": metric, "v": val,
                                             "provenance": "measurement"})
    else:
        live["crux"] = {"state": "awaiting_credential",
                        "unlock": "Add the CRUX_PSI_API_KEY repository secret (free Google API key with Chrome UX Report API enabled)."}

    _append_history(history_rows)

    feed = {
        "schema": SCHEMA,
        "generated_at": generated_at,
        "generator": "command/build_feed.py (hourly via GitHub Actions; also runnable by hand)",
        "disclaimer": ("Every figure carries its own provenance and capture date. "
                       "MEASURED renders only for provenance 'measurement'. Estimates are vendor "
                       "models, never the practice's own record. A gap is a recorded absence, never a zero."),
        "baseline": _read(DATA / "baseline-index.json"),
        "engine": _read(DATA / "engine-coverage.json"),
        "ops_queue": _read(DATA / "ops-queue.json"),
        "priorities": _read(DATA / "priorities.json"),
        "geogrid": _read(DATA / "geogrid.json"),
        "live": live,
        "history": _recent_history(),
    }
    FEED.write_text(json.dumps(feed, separators=(",", ":")), encoding="utf-8")
    n = len(feed["history"])
    print(f"feed.json written {generated_at} — live: "
          f"semrush={live['semrush'].get('state')} crux={live['crux'].get('state')} "
          f"history_rows={n} appended={len(history_rows)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
