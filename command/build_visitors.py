#!/usr/bin/env python3
"""build_visitors.py — edge-measured visitors & intent, per tenant per day.

Reads the CloudFront standard access logs the estate already collects
(atlas-estate-logs bucket, synced to the Mac by cf-ingest) and emits
command/data/visitors.json for the console's Standing view.

This runs on the Mac (the logs live there), on the console-export leg —
NOT in CI (the runner has no logs). A missing day is a recorded absence:
coverage starts when CloudFront logging was enabled (2026-08-22), and the
newest UTC day is always PARTIAL until the day ends.

Definitions (each figure carries these words in the output — nothing is a
GA-style modelled "session"):
  page_views     GET requests answered 200 with content-type text/html,
                 user-agent not on the bot list, path not under /api/.
  unique_ips     distinct client IPs among that day's page_views. An IP is
                 not a person (NAT, mobile carriers) — the label says IPs.
  assist_posts   POST requests to /api/assist* — assistant conversations
                 reaching the estate's own Lambda.
  booking_intent page_views whose path starts with a high-intent stem
                 (/pricing, /contact, /book, /schedule, /consult).
Provenance: measurement (the estate's own edge logs, first party).
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "data" / "visitors.json"

DEFAULT_LOGS = os.path.expanduser(
    "~/Desktop/TULSA_SURGICAL_ARTS copy/ATLAS_ENGINE/DATA_LAKE/state/cf-logs")

TENANTS = ("tsa", "osa")

BOT_RE = re.compile(
    r"bot|crawl|spider|slurp|bingpreview|facebookexternalhit|headless|"
    r"python-requests|python-urllib|curl/|wget/|gptbot|claude|perplexity|"
    r"ccbot|bytespider|petalbot|ahrefs|semrush|mj12|dotbot|scrapy|"
    r"go-http-client|okhttp|dataprovider|expanse|censys|paloalto",
    re.IGNORECASE)

INTENT_PREFIXES = ("/pricing", "/contact", "/book", "/schedule", "/consult")


def parse_dir(d: Path) -> dict:
    """{date: {"pv": int, "ips": set, "assist": int, "intent": int}}"""
    days: dict[str, dict] = {}
    for f in sorted(d.glob("*.gz")):
        try:
            with gzip.open(f, "rt", encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    if line.startswith("#"):
                        continue
                    p = line.rstrip("\n").split("\t")
                    if len(p) < 31:
                        continue
                    date, method, stem, status = p[0], p[5], p[7], p[8]
                    ua = urllib.parse.unquote(p[10] or "")
                    ctype = p[29] if len(p) > 29 else "-"
                    day = days.setdefault(date, {"pv": 0, "ips": set(),
                                                 "assist": 0, "intent": 0})
                    if stem.startswith("/api/assist") and method == "POST":
                        day["assist"] += 1
                        continue
                    if method != "GET" or status != "200":
                        continue
                    if not (ctype or "").startswith("text/html"):
                        continue
                    if stem.startswith("/api/"):
                        continue
                    if BOT_RE.search(ua):
                        continue
                    day["pv"] += 1
                    day["ips"].add(p[4])
                    if any(stem.startswith(x) for x in INTENT_PREFIXES):
                        day["intent"] += 1
        except OSError:
            continue
    return days


def main() -> int:
    logs = Path(os.environ.get("ATLAS_CF_LOGS_DIR", DEFAULT_LOGS))
    today = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d")
    doc = {
        "schema": "atlas-visitors-v1",
        "generated_at": dt.datetime.now(dt.timezone.utc)
            .strftime("%Y-%m-%dT%H:%M:%S+00:00"),
        "provenance": "measurement",
        "source": "CloudFront standard access logs (atlas-estate-logs), "
                  "the estate's own edge — first party, no tag, no vendor",
        "method": {
            "page_views": "GET · 200 · text/html · not /api/ · UA not on "
                          "the bot list",
            "unique_ips": "distinct client IPs among page_views that day — "
                          "an IP is not a person; the label says IPs",
            "assist_posts": "POST /api/assist* — assistant conversations",
            "booking_intent_views": "page_views starting %s"
                                    % (INTENT_PREFIXES,),
        },
        "coverage_note": "CloudFront logging began 2026-08-22; days before "
                         "that are absences, never zeros. The newest UTC "
                         "day is PARTIAL until it ends.",
        "partial_day_utc": today,
        "tenants": {},
    }
    for t in TENANTS:
        d = logs / t
        if not d.is_dir():
            doc["tenants"][t] = {"state": "no_logs_synced",
                                 "why": "cf-ingest has not synced this "
                                        "tenant's logs to this machine"}
            continue
        days = parse_dir(d)
        doc["tenants"][t] = {
            "state": "ok",
            "days": [{"date": k,
                      "page_views": v["pv"],
                      "unique_ips": len(v["ips"]),
                      "assist_posts": v["assist"],
                      "booking_intent_views": v["intent"],
                      "partial": k == today}
                     for k, v in sorted(days.items())],
        }
    OUT.write_text(json.dumps(doc, separators=(",", ":")) + "\n",
                   encoding="utf-8")
    total = sum(len(v.get("days", [])) for v in doc["tenants"].values()
                if isinstance(v, dict))
    print("visitors.json: %d tenant-days written" % total, file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
