#!/usr/bin/env python3
"""build_geogrid_seed.py — the console's Local Grid seed, from the real scan.

Reads the map page's own geogrid.geojson (command/map/data/, produced by the
geogrid-tracker weekly scan through DataForSEO) plus, when this runs on the
Mac, the tracker's summary.json KPIs — and writes command/data/geogrid.json.

One scans[] entry per tracked keyword, cells in row-major grid order, rank
null where the grid point had no SERP data (absence, never zero). ARP and
top-3 share are computed over MEASURED points only and say so.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GEO = HERE / "map" / "data" / "geogrid.geojson"
OUT = HERE / "data" / "geogrid.json"
SUMMARY = Path(os.environ.get(
    "ATLAS_GEOGRID_SUMMARY",
    os.path.expanduser("~/Desktop/TULSA_SURGICAL_ARTS copy/GEOGRID_TSA/"
                       "data/summary.json")))


def main() -> int:
    if not GEO.is_file():
        print("REFUSED: %s missing" % GEO, file=sys.stderr)
        return 1
    gj = json.loads(GEO.read_text(encoding="utf-8"))
    feats = [f for f in gj.get("features", [])
             if (f.get("properties") or {}).get("kind") == "grid"]
    feats.sort(key=lambda f: ((f["properties"].get("row") or 0),
                              (f["properties"].get("col") or 0)))
    keywords = sorted({k for f in feats
                       for k in (f["properties"].get("ranks") or {})})
    n = max((f["properties"].get("row") or 0) for f in feats) + 1 if feats else 0

    kpis = None
    scan_date = None
    if SUMMARY.is_file():
        try:
            sm = json.loads(SUMMARY.read_text(encoding="utf-8"))
            kpis = sm.get("kpis")
            scan_date = (sm.get("generated_at") or "")[:10] or None
        except ValueError:
            pass
    scan_date = scan_date or dt.date.today().isoformat()

    scans = []
    for kw in keywords:
        cells, ranks = [], []
        for f in feats:
            lng, lat = (f.get("geometry") or {}).get("coordinates", [None, None])
            r = ((f["properties"].get("ranks") or {}).get(kw) or {})
            pos = r.get("rank")
            cells.append({"lat": lat, "lng": lng, "position": pos})
            if pos is not None:
                ranks.append(pos)
        measured = len(ranks)
        scans.append({
            "keyword": kw, "date": scan_date, "n": n, "cells": cells,
            "arp": round(sum(ranks) / measured, 2) if measured else None,
            "top3": ("%.0f%% of %d measured points"
                     % (100 * sum(1 for r in ranks if r <= 3) / measured,
                        measured)) if measured else None,
            "measured_points": measured, "grid_points": len(cells),
        })

    OUT.write_text(json.dumps({
        "schema": "atlas-geogrid-v1",
        "state": "measured",
        "generated_at": dt.datetime.now(dt.timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "source": "geogrid-tracker weekly scan (Mon 06:15) through "
                  "DataForSEO; grid + per-point ranks in the map page's own "
                  "geogrid.geojson",
        "note": "Rank null = no SERP data at that point (absence, never "
                "zero). ARP and top-3 share are over measured points only.",
        "kpis": kpis,
        "map_url": "/command/map/",
        "scans": scans,
    }, separators=(",", ":")) + "\n", encoding="utf-8")
    print("geogrid.json: %d keywords × %d points" % (len(scans),
                                                     n * n if n else 0),
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
