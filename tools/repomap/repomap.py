#!/usr/bin/env python3
"""Repomap v0: deterministic, bounded repo summary.

Outputs JSON to stdout per the v0 contract.
"""
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import json
import os
import re
import subprocess
import sys
from typing import Dict, Iterable, List, Optional, Tuple

DEFAULT_MAX_TREE_CHARS = 4000
DEFAULT_MAX_SYMBOLS = 200
DEFAULT_MAX_TOP_FILES = 50
DEFAULT_MAX_HOTSPOTS = 20
DEFAULT_MAX_TREE_DEPTH = 4
DEFAULT_MAX_FILE_KB = 512
DEFAULT_MAX_SCAN_LINES = 4000

DEFAULT_EXCLUDED_DIRS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "DerivedData",
    ".next",
    ".turbo",
    ".cache",
    ".idea",
    ".vscode",
    ".pnpm-store",
    "Pods",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".venv",
    "venv",
    ".tox",
    "target",
    "coverage",
}

IMPORTANT_FILENAMES = {
    "readme",
    "readme.md",
    "readme.rst",
    "readme.txt",
    "package.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "package-lock.json",
    "cargo.toml",
    "pyproject.toml",
    "requirements.txt",
    "setup.py",
    "tsconfig.json",
    "tsconfig.base.json",
    "tsconfig.app.json",
    "tsconfig.node.json",
    "config.yaml",
    "config.yml",
}

ENTRYPOINT_FILENAMES = {
    "main.ts",
    "main.tsx",
    "main.js",
    "main.jsx",
    "index.ts",
    "index.tsx",
    "index.js",
    "index.jsx",
    "app.ts",
    "app.tsx",
    "app.js",
    "app.jsx",
}

TEXT_EXTENSIONS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".swift",
    ".json",
    ".md",
    ".yml",
    ".yaml",
    ".toml",
    ".rs",
    ".go",
    ".java",
    ".kt",
}

SYMBOL_PATTERNS = {
    ".ts": [
        (re.compile(r"^\s*(?:export\s+)?class\s+(\w+)"), "class"),
        (re.compile(r"^\s*(?:export\s+)?interface\s+(\w+)"), "typealias"),
        (re.compile(r"^\s*(?:export\s+)?type\s+(\w+)"), "typealias"),
        (re.compile(r"^\s*(?:export\s+)?enum\s+(\w+)"), "enum"),
        (re.compile(r"^\s*(?:export\s+)?function\s+(\w+)"), "func"),
        (re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)"), "var"),
    ],
    ".tsx": [],
    ".js": [],
    ".jsx": [],
    ".py": [
        (re.compile(r"^\s*class\s+(\w+)"), "class"),
        (re.compile(r"^\s*def\s+(\w+)"), "func"),
    ],
    ".swift": [
        (
            re.compile(
                r"^\s*(?:public|private|internal|open|fileprivate|final|static|class|mutating)?\s*(class|struct|protocol|enum|func|typealias|var|let)\s+(\w+)"
            ),
            None,
        ),
    ],
}

# Reuse TS patterns for JS/TSX/JSX
for ext in (".tsx", ".js", ".jsx"):
    SYMBOL_PATTERNS[ext] = SYMBOL_PATTERNS[".ts"]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", required=True)
    parser.add_argument("--max-tree-chars", type=int, default=DEFAULT_MAX_TREE_CHARS)
    parser.add_argument("--max-symbols", type=int, default=DEFAULT_MAX_SYMBOLS)
    parser.add_argument("--max-top-files", type=int, default=DEFAULT_MAX_TOP_FILES)
    parser.add_argument("--max-hotspots", type=int, default=DEFAULT_MAX_HOTSPOTS)
    parser.add_argument("--max-tree-depth", type=int, default=DEFAULT_MAX_TREE_DEPTH)
    parser.add_argument("--max-file-kb", type=int, default=DEFAULT_MAX_FILE_KB)
    parser.add_argument("--max-scan-lines", type=int, default=DEFAULT_MAX_SCAN_LINES)
    parser.add_argument("--include", action="append", default=[])
    parser.add_argument("--exclude", action="append", default=[])
    return parser.parse_args()


def run_git(repo_root: str, args: List[str]) -> str:
    try:
        result = subprocess.check_output(
            ["git", "-C", repo_root] + args,
            stderr=subprocess.DEVNULL,
            timeout=2,
        )
        return result.decode("utf-8").strip()
    except Exception:
        return ""


def load_gitignore(repo_root: str) -> Tuple[List[str], List[str]]:
    gitignore_path = os.path.join(repo_root, ".gitignore")
    if not os.path.exists(gitignore_path):
        return [], []
    patterns: List[str] = []
    neg_patterns: List[str] = []
    try:
        with open(gitignore_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("!"):
                    neg_patterns.append(line[1:])
                else:
                    patterns.append(line)
    except Exception:
        return [], []
    return patterns, neg_patterns


def match_pattern(pattern: str, rel_path: str, is_dir: bool) -> bool:
    rel_path = rel_path.replace(os.sep, "/")
    pattern = pattern.replace(os.sep, "/")
    if pattern.endswith("/"):
        if not is_dir:
            return False
        prefix = pattern[:-1]
        return rel_path == prefix or rel_path.startswith(prefix + "/")
    return fnmatch.fnmatch(rel_path, pattern) or fnmatch.fnmatch(
        os.path.basename(rel_path), pattern
    )


def should_exclude(
    rel_path: str,
    is_dir: bool,
    exclude_dirs: set,
    exclude_globs: List[str],
    include_globs: List[str],
    gitignore_patterns: List[str],
    gitignore_neg_patterns: List[str],
) -> bool:
    parts = rel_path.replace(os.sep, "/").split("/")
    if any(part in exclude_dirs for part in parts):
        return True

    for pattern in exclude_globs:
        if match_pattern(pattern, rel_path, is_dir):
            return True

    if gitignore_patterns:
        matched = any(match_pattern(p, rel_path, is_dir) for p in gitignore_patterns)
        if matched:
            if gitignore_neg_patterns and any(
                match_pattern(p, rel_path, is_dir) for p in gitignore_neg_patterns
            ):
                return False
            return True

    if include_globs:
        return not any(match_pattern(p, rel_path, is_dir) for p in include_globs)

    return False


def iter_files(
    repo_root: str,
    exclude_dirs: set,
    exclude_globs: List[str],
    include_globs: List[str],
    gitignore_patterns: List[str],
    gitignore_neg_patterns: List[str],
) -> Iterable[Tuple[str, str]]:
    for dirpath, dirnames, filenames in os.walk(repo_root):
        rel_dir = os.path.relpath(dirpath, repo_root)
        if rel_dir == ".":
            rel_dir = ""
        rel_dir_norm = rel_dir.replace(os.sep, "/")

        # prune dirs in-place
        pruned_dirs = []
        for d in sorted(dirnames):
            rel = f"{rel_dir_norm}/{d}" if rel_dir_norm else d
            if should_exclude(
                rel,
                True,
                exclude_dirs,
                exclude_globs,
                include_globs,
                gitignore_patterns,
                gitignore_neg_patterns,
            ):
                continue
            pruned_dirs.append(d)
        dirnames[:] = pruned_dirs

        for filename in sorted(filenames):
            rel = f"{rel_dir_norm}/{filename}" if rel_dir_norm else filename
            if should_exclude(
                rel,
                False,
                exclude_dirs,
                exclude_globs,
                include_globs,
                gitignore_patterns,
                gitignore_neg_patterns,
            ):
                continue
            abs_path = os.path.join(repo_root, rel)
            yield rel.replace(os.sep, "/"), abs_path


def build_tree(
    repo_root: str,
    max_depth: int,
    max_chars: int,
    exclude_dirs: set,
    exclude_globs: List[str],
    include_globs: List[str],
    gitignore_patterns: List[str],
    gitignore_neg_patterns: List[str],
) -> Tuple[str, bool]:
    lines: List[str] = []

    def walk(dir_path: str, depth: int) -> None:
        if depth > max_depth:
            return
        try:
            entries = sorted(os.listdir(dir_path))
        except Exception:
            return

        dirs = []
        files = []
        rel_dir = os.path.relpath(dir_path, repo_root)
        rel_dir = "" if rel_dir == "." else rel_dir.replace(os.sep, "/")

        for entry in entries:
            full = os.path.join(dir_path, entry)
            rel = f"{rel_dir}/{entry}" if rel_dir else entry
            if os.path.isdir(full):
                if should_exclude(
                    rel,
                    True,
                    exclude_dirs,
                    exclude_globs,
                    include_globs,
                    gitignore_patterns,
                    gitignore_neg_patterns,
                ):
                    continue
                dirs.append((entry, full, rel))
            else:
                if should_exclude(
                    rel,
                    False,
                    exclude_dirs,
                    exclude_globs,
                    include_globs,
                    gitignore_patterns,
                    gitignore_neg_patterns,
                ):
                    continue
                files.append((entry, rel))

        for entry, full, rel in dirs:
            lines.append("  " * depth + entry + "/")
            if depth < max_depth:
                walk(full, depth + 1)

        for entry, rel in files:
            lines.append("  " * depth + entry)

    walk(repo_root, 0)
    tree = "\n".join(lines)
    if len(tree) <= max_chars:
        return tree, False
    truncated = tree[:max_chars]
    last_newline = truncated.rfind("\n")
    if last_newline > 0:
        truncated = truncated[:last_newline]
    return truncated, True


def scan_file(
    rel_path: str,
    abs_path: str,
    max_file_kb: int,
    max_scan_lines: int,
) -> Tuple[Optional[int], List[Dict]]:
    size_kb = os.path.getsize(abs_path) / 1024
    if size_kb > max_file_kb:
        return None, []
    ext = os.path.splitext(rel_path)[1].lower()
    patterns = SYMBOL_PATTERNS.get(ext)
    symbols: List[Dict] = []
    line_count = 0

    try:
        with open(abs_path, "r", encoding="utf-8", errors="ignore") as f:
            for line in f:
                line_count += 1
                if line_count > max_scan_lines:
                    break
                if not patterns:
                    continue
                stripped = line.strip()
                if not stripped or stripped.startswith(":"):
                    continue
                if stripped.startswith("#") or stripped.startswith("//"):
                    continue
                if stripped.startswith("/*") or stripped.startswith("*"):
                    continue
                for pattern, kind in patterns:
                    match = pattern.match(line)
                    if not match:
                        continue
                    if kind is None:
                        keyword = match.group(1)
                        name = match.group(2)
                        kind = keyword
                    else:
                        name = match.group(1)
                    if kind not in {
                        "class",
                        "struct",
                        "func",
                        "protocol",
                        "enum",
                        "typealias",
                        "var",
                        "let",
                    }:
                        # Map unknowns to typealias or func
                        if kind in {"interface"}:
                            kind = "typealias"
                        elif kind in {"function"}:
                            kind = "func"
                        elif kind in {"const"}:
                            kind = "var"
                        else:
                            kind = "typealias"
                    symbols.append(
                        {
                            "name": name,
                            "kind": kind,
                            "path": rel_path,
                            "line": line_count,
                        }
                    )
                    break
    except Exception:
        return None, []

    return line_count, symbols


def main() -> int:
    args = parse_args()
    repo_root = os.path.abspath(args.repo_root)
    if not os.path.isdir(repo_root):
        print(json.dumps({"error": "repo_root is not a directory"}))
        return 1

    git_head = run_git(repo_root, ["rev-parse", "HEAD"])

    exclude_dirs = set(DEFAULT_EXCLUDED_DIRS)
    exclude_globs = list(args.exclude or [])
    include_globs = list(args.include or [])
    gitignore_patterns, gitignore_neg = load_gitignore(repo_root)

    files: List[Tuple[str, str]] = list(
        iter_files(
            repo_root,
            exclude_dirs,
            exclude_globs,
            include_globs,
            gitignore_patterns,
            gitignore_neg,
        )
    )

    file_infos: List[Dict] = []
    symbols: List[Dict] = []
    line_counts: Dict[str, int] = {}
    symbols_truncated = False

    for rel_path, abs_path in files:
        try:
            size = os.path.getsize(abs_path)
            mtime = os.path.getmtime(abs_path)
        except Exception:
            continue
        file_infos.append(
            {
                "path": rel_path,
                "size": size,
                "mtime": mtime,
            }
        )

        if os.path.splitext(rel_path)[1].lower() in TEXT_EXTENSIONS or os.path.basename(
            rel_path
        ).lower() in IMPORTANT_FILENAMES:
            line_count, file_symbols = scan_file(
                rel_path, abs_path, args.max_file_kb, args.max_scan_lines
            )
            if line_count is not None:
                line_counts[rel_path] = line_count
            if not symbols_truncated and file_symbols:
                remaining = args.max_symbols - len(symbols)
                if remaining <= 0:
                    symbols_truncated = True
                else:
                    symbols.extend(file_symbols[:remaining])
                    if len(symbols) >= args.max_symbols:
                        symbols_truncated = True

    # Build tree
    tree, tree_truncated = build_tree(
        repo_root,
        args.max_tree_depth,
        args.max_tree_chars,
        exclude_dirs,
        exclude_globs,
        include_globs,
        gitignore_patterns,
        gitignore_neg,
    )

    # Top files
    def score_file(path: str) -> Tuple[int, str]:
        base = os.path.basename(path).lower()
        score = 0
        reason = "other"
        if base in IMPORTANT_FILENAMES:
            score += 100
            reason = "config"
        if base.startswith("readme"):
            score += 120
            reason = "readme"
        if base in ENTRYPOINT_FILENAMES:
            score += 60
            reason = "entrypoint"
        if "/src/" in f"/{path}" or "/core/" in f"/{path}":
            score += 15
            if reason == "other":
                reason = "core"
        if path in line_counts:
            score += min(line_counts[path] // 50, 40)
            if line_counts[path] >= 400:
                reason = "large"
        return score, reason

    scored = []
    for info in file_infos:
        score, reason = score_file(info["path"])
        scored.append((score, info["path"], reason))
    scored.sort(key=lambda x: (-x[0], x[1]))
    top_files: List[Dict] = [
        {"path": path, "reason": reason}
        for _, path, reason in scored[: args.max_top_files]
    ]

    # Symbols
    symbols.sort(key=lambda s: (s["path"], s["line"], s["name"]))

    # Hotspots
    hotspots: List[Dict] = []
    for path, count in sorted(
        line_counts.items(), key=lambda x: (-x[1], x[0])
    ):
        if len(hotspots) >= args.max_hotspots:
            break
        signals = []
        if count >= 400:
            signals.append("large")
        if "/src/" in f"/{path}" or "/core/" in f"/{path}":
            signals.append("core")
        if signals:
            hotspots.append({"path": path, "signals": signals})

    notes: List[str] = []
    if tree_truncated:
        notes.append("tree truncated")
    if symbols_truncated:
        notes.append("symbols truncated")
    if len(top_files) >= args.max_top_files:
        notes.append("top_files truncated")
    if len(hotspots) >= args.max_hotspots:
        notes.append("hotspots truncated")
    if gitignore_patterns:
        notes.append(".gitignore patterns applied (basic)")
    if not git_head:
        notes.append("git head unavailable")

    output = {
        "repo_root": repo_root,
        "generated_at": dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "git_head": git_head or "",
        "tree": tree,
        "top_files": top_files,
        "symbols": symbols[: args.max_symbols],
        "hotspots": hotspots,
        "notes": notes,
    }

    print(json.dumps(output, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
