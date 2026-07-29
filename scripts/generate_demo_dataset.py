#!/usr/bin/env python3
"""Generate the bundled demo dataset for Keystone's demo mode.

Demo mode exists so the control plane can be shown end to end when the
ServiceNow instance is slow or unreachable. That means the dataset it replays
has to look like a real migration run rather than a golden path: several source
systems of differing quality, several proposed CI classes, and a spread of
reconciliation outcomes including the ones a human has to resolve.

Output: app/lib/cmdb/demo-dataset.json

Two properties this file is responsible for:

  Deterministic. A fixed seed and sorted JSON keys, so regenerating produces a
  byte-identical file. Screenshots, smoke assertions, and the visual replay all
  depend on the run never shifting under them.

  Self-consistent. Every count the UI quotes is computed here, once, from the
  records actually emitted, and written into `summary`. The TypeScript fixture
  re-derives the same numbers from the `cis` array and `smoke:demo-fallback`
  asserts the two agree — so a drift between the prose and the table is a test
  failure rather than something a viewer notices during a demo.

Usage:
    python scripts/generate_demo_dataset.py
    python scripts/generate_demo_dataset.py --check   # verify committed file is current
"""

from __future__ import annotations

import argparse
import json
import pathlib
import random
import sys
from collections import Counter

# The run is entirely synthetic. Hostnames use RFC 2606 reserved domains and
# every CIDR comes from the RFC 5737 documentation ranges, so nothing here can
# be mistaken for a real company's infrastructure.
SEED = 20260729
RECORD_COUNT = 600
DATASET_NAME = "Contoso datacenter consolidation extract"
DATASET_FILE = "contoso-cmdb-extract.json"
GENERATED_ON = "2026-07-28"

# The deterministic confidence gate. At or above this, identity is trustworthy.
GATE_THRESHOLD = 0.50

# ---------------------------------------------------------------------------
# Classes
# ---------------------------------------------------------------------------

CLASSES = {
    "linux": ("cmdb_ci_linux_server", "Linux Server"),
    "windows": ("cmdb_ci_win_server", "Windows Server"),
    "database": ("cmdb_ci_db_instance", "Database Instance"),
    "network": ("cmdb_ci_ip_network", "IP Network"),
    "application": ("cmdb_ci_appl", "Application"),
    "netgear": ("cmdb_ci_netgear", "Network Gear"),
}

SITES = ["lon", "fra", "iad", "syd", "sin"]
ENVIRONMENTS = ["production", "staging", "development", "dr"]
DB_ENGINES = ["postgres", "mssql", "oracle", "mysql"]
APP_NAMES = ["billing", "checkout", "identity", "reporting", "inventory", "notify"]
AWS_REGIONS = ["us-east-1", "eu-west-1", "ap-southeast-2", "us-west-2"]
DOC_NETWORKS = ["192.0.2", "198.51.100", "203.0.113"]

# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------
#
# Each source contributes a fixed number of records with its own class mix and
# its own quality profile, because that is what actually drives the Sankey:
# a well-run Discovery scan and a hand-maintained spreadsheet do not fail in the
# same proportions. `mix` weights are relative within the source.
#
# `quality` is the probability of each reconciliation outcome. They sum to 1.0
# and are asserted below so a hand edit cannot silently skew a source.

SOURCES = [
    {
        "id": "sn-discovery",
        "label": "ServiceNow Discovery",
        "count": 236,
        "mix": {"linux": 5, "windows": 4, "database": 2, "application": 3},
        # Agent-based discovery: authoritative identity, mostly new or already correct.
        "quality": {
            "INSERT": 0.72,
            "UPDATE": 0.15,
            "NO_CHANGE": 0.06,
            "REVIEW": 0.03,
            "INSERT_AS_INCOMPLETE": 0.03,
            "ERROR": 0.01,
        },
    },
    {
        "id": "vcenter",
        "label": "vCenter inventory export",
        "count": 152,
        "mix": {"linux": 6, "windows": 5},
        # Overlaps Discovery heavily — the same guest seen twice is the classic
        # duplicate-identity case, so REVIEW is the largest defect here.
        "quality": {
            "INSERT": 0.60,
            "UPDATE": 0.12,
            "NO_CHANGE": 0.05,
            "REVIEW": 0.15,
            "INSERT_AS_INCOMPLETE": 0.06,
            "ERROR": 0.02,
        },
    },
    {
        "id": "aws-ip-ranges",
        "label": "AWS IP ranges",
        "count": 124,
        "mix": {"network": 1},
        # Machine-published and schema-clean, but the umbrella service
        # republishes prefixes, and local zones carry no derivable owner.
        "quality": {
            "INSERT": 0.74,
            "UPDATE": 0.04,
            "NO_CHANGE": 0.02,
            "REVIEW": 0.12,
            "INSERT_AS_INCOMPLETE": 0.07,
            "ERROR": 0.01,
        },
    },
    {
        "id": "legacy-asset-csv",
        "label": "Legacy asset spreadsheet",
        "count": 88,
        "mix": {"netgear": 4, "windows": 2, "database": 2, "application": 1},
        # Hand-maintained for years. Most of the run's defects live here.
        "quality": {
            "INSERT": 0.38,
            "UPDATE": 0.12,
            "NO_CHANGE": 0.05,
            "REVIEW": 0.16,
            "INSERT_AS_INCOMPLETE": 0.21,
            "ERROR": 0.08,
        },
    },
]

# Confidence bands per outcome. Everything at or above GATE_THRESHOLD clears the
# gate; everything below is held. The bands are disjoint across that line on
# purpose, so "cleared" and "held" can never disagree with the score shown.
CONFIDENCE_BANDS = {
    "INSERT": (0.88, 0.99),
    "UPDATE": (0.80, 0.94),
    "NO_CHANGE": (0.90, 0.99),
    "REVIEW": (0.38, 0.49),
    "INSERT_AS_INCOMPLETE": (0.30, 0.47),
    "ERROR": (0.12, 0.28),
}

# Why a record is not eligible for autonomous migration. Written per record so
# the operator sees a specific cause, not a category.
HOLD_REASONS = {
    "UPDATE": "An existing CI already matches this record. Changes to existing CIs are outside the autonomous boundary.",
    "NO_CHANGE": "An existing CI already matches and carries identical attributes. Nothing to apply.",
    # Two genuinely different duplicate conditions, worded for the one that
    # actually applies: the same asset found by two scanners, versus the same
    # asset listed twice within one feed.
    "REVIEW_CROSS": "Reconciles to the same identity as {other}, discovered by {other_source}. One record must be chosen.",
    "REVIEW_SAME": "{source} lists this asset twice: {other} carries the same identity. One record must be chosen.",
    "INSERT_AS_INCOMPLETE": "{missing} is missing, so the CI would be created without a resolvable owner.",
    "ERROR": "{name} already exists in the CMDB under class {conflict}. IRE cannot reconcile a class change.",
}

MISSING_ATTRIBUTES = [
    "Support group",
    "Business owner",
    "Operating system version",
    "Serial number",
    "Location",
]

CONFLICT_CLASSES = ["cmdb_ci_server", "cmdb_ci_computer", "cmdb_ci_netgear", "cmdb_ci_appl"]


def _weighted_pick(rng: random.Random, weights: dict[str, float]) -> str:
    """Pick a key with probability proportional to its weight."""
    total = sum(weights.values())
    roll = rng.random() * total
    upto = 0.0
    for key, weight in weights.items():
        upto += weight
        if roll <= upto:
            return key
    return next(iter(weights))


def _name_for(rng: random.Random, kind: str, ordinal: int) -> tuple[str, str, str]:
    """Return (name, address, environment) shaped like the class it belongs to."""
    site = SITES[ordinal % len(SITES)]
    env = ENVIRONMENTS[ordinal % len(ENVIRONMENTS)]
    if kind == "linux":
        return f"lnx-{site}-{ordinal:04d}.corp.example", f"10.{ordinal % 240}.{ordinal % 250}.11", env
    if kind == "windows":
        return f"win-{site}-{ordinal:04d}.corp.example", f"10.{ordinal % 240}.{ordinal % 250}.21", env
    if kind == "database":
        engine = DB_ENGINES[ordinal % len(DB_ENGINES)]
        return f"db-{engine}-{site}-{ordinal:03d}.corp.example", f"10.{ordinal % 240}.{ordinal % 250}.31", env
    if kind == "application":
        app = APP_NAMES[ordinal % len(APP_NAMES)]
        return f"app-{app}-{env}-{ordinal:03d}", "", env
    if kind == "netgear":
        return f"sw-{site}-{ordinal:03d}.corp.example", f"10.{ordinal % 240}.{ordinal % 250}.1", env
    # network
    region = AWS_REGIONS[ordinal % len(AWS_REGIONS)]
    net = DOC_NETWORKS[ordinal % len(DOC_NETWORKS)]
    cidr = f"{net}.{ordinal % 256}/32"
    return f"aws-{region}-{cidr}", cidr, region


def build_dataset() -> dict:
    rng = random.Random(SEED)

    for source in SOURCES:
        total = round(sum(source["quality"].values()), 6)
        if total != 1.0:
            raise SystemExit(f"source {source['id']} quality weights sum to {total}, expected 1.0")
    if sum(source["count"] for source in SOURCES) != RECORD_COUNT:
        raise SystemExit("source counts do not sum to RECORD_COUNT")

    cis: list[dict] = []
    index = 0

    for source in SOURCES:
        for _ in range(source["count"]):
            kind = _weighted_pick(rng, source["mix"])
            table, label = CLASSES[kind]
            operation = _weighted_pick(rng, source["quality"])
            name, address, env = _name_for(rng, kind, index)
            low, high = CONFIDENCE_BANDS[operation]
            confidence = round(rng.uniform(low, high), 2)

            cis.append({
                "index": index,
                "name": name,
                "kind": kind,
                "class_table": table,
                "class_label": label,
                "source_id": source["id"],
                "source_label": source["label"],
                "source_record_id": f"{source['id']}:{index:05d}",
                "operation": operation,
                "confidence": confidence,
                "ip_address": address,
                "environment": env,
                "support_group": f"{kind}-ops",
            })
            index += 1

    _assign_hold_reasons(rng, cis)
    relationships = _build_relationships(rng, cis)
    summary = _summarize(cis, relationships)

    return {
        "dataset": {
            "name": DATASET_NAME,
            "file": DATASET_FILE,
            "generated_on": GENERATED_ON,
            "generator": "scripts/generate_demo_dataset.py",
            "seed": SEED,
            "gate_threshold": GATE_THRESHOLD,
            "notice": "Synthetic. Hostnames use RFC 2606 reserved domains; CIDRs use RFC 5737 documentation ranges.",
        },
        "sources": [{"id": s["id"], "label": s["label"], "count": s["count"]} for s in SOURCES],
        "classes": [{"table": t, "label": l} for t, l in sorted(set(CLASSES.values()))],
        "cis": cis,
        "relationships": relationships,
        "summary": summary,
    }


def _assign_hold_reasons(rng: random.Random, cis: list[dict]) -> None:
    """Attach a specific, record-level reason to everything outside the cohort.

    Every duplicate names a concrete earlier record it collides with, and the
    wording matches which collision it actually is. Cross-source is preferred
    (two scanners found the same machine, the classic case); where a class comes
    from a single feed, the collision is a within-feed republication instead —
    equally real, and the reason says so rather than inventing a second scanner.
    """
    by_kind: dict[str, list[dict]] = {}
    for ci in cis:
        if ci["operation"] in ("INSERT", "UPDATE", "NO_CHANGE"):
            by_kind.setdefault(ci["kind"], []).append(ci)

    for ci in cis:
        operation = ci["operation"]
        if operation == "INSERT":
            continue

        if operation == "REVIEW":
            earlier = [other for other in by_kind.get(ci["kind"], []) if other["index"] < ci["index"]]
            cross = [other for other in earlier if other["source_id"] != ci["source_id"]]
            pool = cross or earlier
            if pool:
                other = pool[rng.randrange(len(pool))]
                ci["duplicate_of_index"] = other["index"]
                ci["hold_reason"] = (
                    HOLD_REASONS["REVIEW_CROSS"].format(
                        other=other["name"], other_source=other["source_label"])
                    if other["source_id"] != ci["source_id"]
                    else HOLD_REASONS["REVIEW_SAME"].format(
                        source=ci["source_label"], other=other["name"])
                )
            else:
                # Nothing earlier of this class exists to collide with, so this
                # row is not a duplicate — demote it rather than assert one.
                ci["operation"] = "INSERT_AS_INCOMPLETE"
                low, high = CONFIDENCE_BANDS["INSERT_AS_INCOMPLETE"]
                ci["confidence"] = round(rng.uniform(low, high), 2)
                operation = "INSERT_AS_INCOMPLETE"

        if operation == "INSERT_AS_INCOMPLETE":
            missing = MISSING_ATTRIBUTES[ci["index"] % len(MISSING_ATTRIBUTES)]
            ci["missing_attribute"] = missing
            ci["hold_reason"] = HOLD_REASONS["INSERT_AS_INCOMPLETE"].format(missing=missing)
        elif operation == "ERROR":
            conflict = CONFLICT_CLASSES[ci["index"] % len(CONFLICT_CLASSES)]
            ci["conflict_class"] = conflict
            ci["hold_reason"] = HOLD_REASONS["ERROR"].format(name=ci["name"], conflict=conflict)
        elif operation in ("UPDATE", "NO_CHANGE"):
            ci["matched"] = True
            ci["hold_reason"] = HOLD_REASONS[operation]


def _build_relationships(rng: random.Random, cis: list[dict]) -> list[dict]:
    """Infrastructure-shaped edges between records that actually exist.

    Only non-held records get edges: a relationship whose endpoint is still
    awaiting a human decision cannot be promoted anyway, and staging one would
    inflate relationship coverage with work that cannot land.
    """
    eligible = [ci for ci in cis if "hold_reason" not in ci]
    by_kind: dict[str, list[dict]] = {}
    for ci in eligible:
        by_kind.setdefault(ci["kind"], []).append(ci)

    edges: list[dict] = []
    seen: set[tuple[int, int]] = set()

    def link(parent: dict, child: dict, rel_type: str) -> None:
        key = (parent["index"], child["index"])
        if parent["index"] == child["index"] or key in seen:
            return
        seen.add(key)
        edges.append({
            "parent_index": parent["index"],
            "child_index": child["index"],
            "type": rel_type,
            "confidence": round(rng.uniform(0.72, 0.98), 2),
        })

    servers = by_kind.get("linux", []) + by_kind.get("windows", [])
    for app in by_kind.get("application", []):
        if servers:
            link(app, servers[app["index"] % len(servers)], "Runs on::Runs")
    for db in by_kind.get("database", []):
        if servers:
            link(db, servers[(db["index"] * 7) % len(servers)], "Hosted on::Hosts")
    networks = by_kind.get("network", [])
    for i, server in enumerate(servers):
        if networks and i % 3 == 0:
            link(server, networks[i % len(networks)], "Member of::Contains")
    for switch in by_kind.get("netgear", []):
        if networks:
            link(switch, networks[(switch["index"] * 3) % len(networks)], "Connects to::Connected by")

    edges.sort(key=lambda e: (e["parent_index"], e["child_index"]))
    return edges


def _summarize(cis: list[dict], relationships: list[dict]) -> dict:
    """Compute every number the UI is allowed to quote, from the records emitted."""
    total = len(cis)
    operations = Counter(ci["operation"] for ci in cis)
    by_source = Counter(ci["source_label"] for ci in cis)
    by_class = Counter(ci["class_label"] for ci in cis)

    cleared = [ci for ci in cis if ci["confidence"] >= GATE_THRESHOLD]
    held = [ci for ci in cis if ci["confidence"] < GATE_THRESHOLD]
    autonomous = [ci for ci in cis if "hold_reason" not in ci]
    matched = operations["UPDATE"] + operations["NO_CHANGE"]
    defects = operations["REVIEW"] + operations["INSERT_AS_INCOMPLETE"] + operations["ERROR"]

    touched = {e["parent_index"] for e in relationships} | {e["child_index"] for e in relationships}

    # Dimension scores are shares of the same population, so a KPI tile can
    # never contradict the table beneath it.
    def share(count: int) -> int:
        return round((count / total) * 100)

    completeness = share(total - operations["INSERT_AS_INCOMPLETE"])
    correctness = share(total - operations["REVIEW"] - operations["ERROR"])
    compliance = share(len(cleared))

    return {
        "record_count": total,
        "operations": dict(sorted(operations.items())),
        "by_source": dict(sorted(by_source.items())),
        "by_class": dict(sorted(by_class.items())),
        "gate_threshold": GATE_THRESHOLD,
        "cleared_count": len(cleared),
        "held_count": len(held),
        # Three distinct populations, kept apart because they mean different
        # things to an operator. Collapsing matched records into a "review
        # backlog" would report healthy data as a quality problem.
        "autonomous_count": len(autonomous),          # Mara may migrate unattended
        "matched_count": matched,                     # fine, but needs an approval
        "defect_count": defects,                      # genuinely needs resolving
        "review_backlog_count": total - len(autonomous),
        "duplicate_count": operations["REVIEW"],
        "incomplete_count": operations["INSERT_AS_INCOMPLETE"],
        "error_count": operations["ERROR"],
        "stale_count": sum(1 for ci in cis if ci["index"] % 53 == 11),
        "relationship_count": len(relationships),
        "related_ci_count": len(touched),
        "orphan_count": total - len(touched),
        "cleared_confidence_min": min((ci["confidence"] for ci in cleared), default=0),
        "cleared_confidence_max": max((ci["confidence"] for ci in cleared), default=0),
        "held_confidence_max": max((ci["confidence"] for ci in held), default=0),
        "completeness": completeness,
        "correctness": correctness,
        "compliance": compliance,
        # The two endpoints of the health scale, not three fixed readings.
        #
        # `baseline` is the staged data as it arrived, averaged across the three
        # dimensions above. `projected` is where the CMDB lands once everything
        # resolvable has been resolved — short of 100 by the class conflicts,
        # which this pipeline will never decide on its own. It floors rather
        # than rounds so those records cannot vanish into a perfect score.
        #
        # The reading *between* them is not stored: it depends on how much has
        # actually been verified so far, so the transport interpolates it from
        # live progress. A fixed middle value is exactly what made the old
        # projected score sit still while remediation ran.
        "baseline_score": round((completeness + correctness + compliance) / 3),
        "projected_score": int(((total - operations["ERROR"]) / total) * 100),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true",
                        help="exit non-zero if the committed dataset differs from a fresh generation")
    args = parser.parse_args()

    target = pathlib.Path(__file__).resolve().parent.parent / "app" / "lib" / "cmdb" / "demo-dataset.json"
    payload = json.dumps(build_dataset(), indent=2, sort_keys=True) + "\n"

    if args.check:
        if not target.exists():
            print(f"FAIL {target} does not exist; run: python scripts/generate_demo_dataset.py")
            return 1
        current = target.read_text(encoding="utf-8")
        if current != payload:
            print("FAIL demo-dataset.json is stale; run: python scripts/generate_demo_dataset.py")
            return 1
        print("ok   demo-dataset.json matches a fresh generation")
        return 0

    target.write_text(payload, encoding="utf-8")
    summary = json.loads(payload)["summary"]
    print(f"wrote {target.relative_to(pathlib.Path.cwd()) if target.is_relative_to(pathlib.Path.cwd()) else target}")
    print(f"  {summary['record_count']} records "
          f"| {len(summary['by_source'])} sources "
          f"| {len(summary['by_class'])} classes")
    print(f"  operations: {summary['operations']}")
    print(f"  autonomous {summary['autonomous_count']} "
          f"| held for review {summary['review_backlog_count']} "
          f"| relationships {summary['relationship_count']}")
    print(f"  health {summary['baseline_score']} -> {summary['projected_score']} (interpolated by progress)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
