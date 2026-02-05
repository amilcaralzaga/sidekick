#!/usr/bin/env python3
"""
Render an AI decision log (.jsonl) to Markdown + HTML.

Usage:
  python decision-log-render.py decision-log.jsonl --out decision-log-report --utc-offset +01:00

Notes:
- No external dependencies.
- HTML output is a simple self-contained file with a table.
"""
from __future__ import annotations
import argparse, json
from datetime import datetime, timezone, timedelta

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("jsonl", help="Path to .jsonl file")
    p.add_argument("--out", default="decision-log-report", help="Output base name (no extension)")
    p.add_argument("--utc-offset", default="+01:00", help="UTC offset for local display, e.g. +01:00")
    return p.parse_args()

def utc_offset_to_tz(offset: str) -> timezone:
    sign = 1 if offset.startswith("+") else -1
    hh, mm = offset[1:].split(":")
    return timezone(sign * timedelta(hours=int(hh), minutes=int(mm)))

def esc(s: str) -> str:
    return s.replace("&","&amp;").replace("<","&lt;").replace(">","&gt;")

def main():
    args = parse_args()
    tz = utc_offset_to_tz(args.utc_offset)

    entries = []
    with open(args.jsonl, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                entries.append(json.loads(line))

    def get_diff_stats(e: dict) -> dict:
        return e.get("change", {}).get("diffStats", e.get("diffStats", {})) or {}

    def get_files(e: dict) -> list:
        return e.get("change", {}).get("filesTouched", e.get("filesTouched", [])) or []

    def get_predictability(e: dict) -> str:
        return (e.get("classification", {}) or {}).get("predictability") or e.get("predictability", "")

    def get_operation(e: dict) -> str:
        op = e.get("operation", {}) or {}
        return op.get("type") or op.get("operationType") or e.get("operationType", "")

    def get_decision_note(e: dict) -> str:
        rationale = e.get("rationale", {}) or {}
        return rationale.get("decisionNote") or e.get("decisionNote", "")

    total_added = sum(get_diff_stats(e).get("linesAdded", 0) for e in entries)
    total_removed = sum(get_diff_stats(e).get("linesRemoved", 0) for e in entries)

    def local_time(ts: str) -> str:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.astimezone(tz).strftime("%Y-%m-%d %H:%M:%S")

    # Markdown
    md = []
    md.append("# AI Decision Log Report\n\n")
    md.append(f"**Source file:** `{args.jsonl}`  \n")
    md.append(f"**Entries:** {len(entries)}  \n")
    md.append(f"**Net LOC delta (added − removed):** {total_added} − {total_removed} = **+{total_added-total_removed}**\n\n")
    md.append("| Local time | Predictability | Operation | Files | + | − | Decision note |\n")
    md.append("|---|---:|---|---|---:|---:|---|\n")
    for e in sorted(entries, key=lambda x: x.get("timestamp", "")):
        files = ", ".join(get_files(e))
        diff_stats = get_diff_stats(e)
        md.append(
            f"| {local_time(e.get('timestamp',''))} | {get_predictability(e)} | {get_operation(e)} | "
            f"`{files}` | {diff_stats.get('linesAdded',0)} | {diff_stats.get('linesRemoved',0)} | {get_decision_note(e)} |\n"
        )
    md_text = "".join(md)
    with open(args.out + ".md", "w", encoding="utf-8") as f:
        f.write(md_text)

    # HTML
    rows = []
    for e in sorted(entries, key=lambda x: x.get("timestamp", "")):
        files = ", ".join(get_files(e))
        diff_stats = get_diff_stats(e)
        rows.append(
            "<tr>"
            f"<td>{esc(local_time(e.get('timestamp','')))}</td>"
            f"<td>{esc(get_predictability(e))}</td>"
            f"<td>{esc(get_operation(e))}</td>"
            f"<td><code>{esc(files)}</code></td>"
            f"<td style='text-align:right'>{diff_stats.get('linesAdded',0)}</td>"
            f"<td style='text-align:right'>{diff_stats.get('linesRemoved',0)}</td>"
            f"<td>{esc(get_decision_note(e))}</td>"
            "</tr>"
        )

    html = f"""<!doctype html>
<html><head><meta charset="utf-8"><title>AI Decision Log Report</title>
<style>
body{{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;margin:40px;line-height:1.35;}}
table{{border-collapse:collapse;width:100%;}}
th,td{{border:1px solid #ddd;padding:8px;vertical-align:top;}}
th{{background:#f5f5f5;text-align:left;}}
code{{background:#f1f1f1;padding:2px 4px;border-radius:4px;}}
</style></head><body>
<h1>AI Decision Log Report</h1>
<p><b>Source file:</b> <code>{esc(args.jsonl)}</code><br>
<b>Entries:</b> {len(entries)}<br>
<b>Net LOC delta:</b> +{total_added-total_removed}</p>
<table>
<thead><tr>
<th>Local time</th><th>Predictability</th><th>Operation</th><th>Files</th><th style="text-align:right">+</th><th style="text-align:right">−</th><th>Decision note</th>
</tr></thead>
<tbody>
{''.join(rows)}
</tbody></table>
</body></html>"""
    with open(args.out + ".html", "w", encoding="utf-8") as f:
        f.write(html)

if __name__ == "__main__":
    main()
