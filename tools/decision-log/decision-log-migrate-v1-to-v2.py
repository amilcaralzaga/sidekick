#!/usr/bin/env python3
"""
Migrate decision-log.jsonl (v1-ish) to v2-ish shape.

- Adds UUID `id`
- Wraps `operation`, `change`, `classification`, `rationale`
- Preserves unknowns as explicit "unknown"/null

Usage:
  python decision-log-migrate-v1-to-v2.py decision-log.jsonl --out decision-log.v2.jsonl
"""
from __future__ import annotations
import argparse, json, uuid

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("jsonl", help="Input v1 .jsonl")
    p.add_argument("--out", default="decision-log.v2.jsonl", help="Output v2 .jsonl")
    return p.parse_args()

def main():
    args = parse_args()
    out = open(args.out, "w", encoding="utf-8")

    with open(args.jsonl, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            e = json.loads(line)

            v2 = {
                "id": str(uuid.uuid4()),
                "timestamp": e.get("timestamp"),
                "workspaceRoot": e.get("workspaceRoot", ""),
                "repoRoot": e.get("repoRoot", ""),
                "git": {
                    # v1 only provides a single gitHead; cannot infer headBefore/headAfter.
                    "headBefore": None,
                    "headAfter": e.get("gitHead"),
                    "branch": None,
                    "dirty": None,
                },
                "operation": {
                    "type": e.get("operationType"),
                    "operationType": e.get("operationType"),
                },
                "change": {
                    "filesTouched": e.get("filesTouched", []),
                    "diffStats": e.get("diffStats", {}),
                },
                "classification": {
                    "predictability": e.get("predictability", "unknown"),
                    "impact": "unknown",
                    "riskDomains": [],
                    "safetyCritical": None,
                },
                "rationale": {
                    "decisionNote": e.get("decisionNote", ""),
                    "aiActionSummary": e.get("aiActionSummary", ""),
                    "planTitle": e.get("planTitle", ""),
                    "planPath": e.get("planPath", ""),
                },
                "verification": {
                    "tests": [],
                    "benchmarks": [],
                },
                "approvals": [],
                "traceability": {
                    "requirements": [],
                    "risks": [],
                    "tickets": [],
                },
            }

            out.write(json.dumps(v2, ensure_ascii=False) + "\n")

    out.close()

if __name__ == "__main__":
    main()
