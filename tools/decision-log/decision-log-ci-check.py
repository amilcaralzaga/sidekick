#!/usr/bin/env python3
"""
CI gate for AI decision logs (v2-ish).

Fails the build if any `design` entry is missing:
- at least one approval
- at least one verification artifact (test or benchmark)

Usage:
  python decision-log-ci-check.py decision-log.v2.jsonl
"""
from __future__ import annotations
import json, sys

def load(path: str):
    with open(path, "r", encoding="utf-8") as f:
        for i, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                yield i, json.loads(line)
            except Exception as ex:
                raise RuntimeError(f"Line {i}: invalid JSON: {ex}")

def main():
    if len(sys.argv) != 2:
        print("Usage: python decision-log-ci-check.py <decision-log.v2.jsonl>", file=sys.stderr)
        sys.exit(2)

    path = sys.argv[1]
    failures = []

    for lineno, e in load(path):
        pred = (e.get("classification", {}) or {}).get("predictability", e.get("predictability", "unknown"))
        if pred != "design":
            continue

        approvals = e.get("approvals", []) or []
        verification = e.get("verification", {}) or {}
        tests = verification.get("tests", []) or []
        benchmarks = verification.get("benchmarks", []) or []

        if not approvals:
            failures.append((lineno, e.get("id", "<no id>"), "missing approvals[]"))
        if not tests and not benchmarks:
            failures.append((lineno, e.get("id", "<no id>"), "missing verification.tests[] / benchmarks[]"))

    if failures:
        print("Decision-log CI check FAILED:")
        for lineno, eid, reason in failures:
            print(f"- line {lineno} (id={eid}): {reason}")
        sys.exit(1)

    print("Decision-log CI check passed.")
    sys.exit(0)

if __name__ == "__main__":
    main()
