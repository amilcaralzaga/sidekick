# DevSherpa (Continue Fork): Intent + Delta

This repository is a fork of **Continue** (the open-source AI coding assistant). We use Continue as the IDE surface, then layer in **repo-enforced governance** and **deterministic, bounded context** so teams can use AI assistance without “vibe-coding” or losing traceability.

## Intent (Why This Fork Exists)

DevSherpa’s goal is to make AI-assisted development **audit-friendly and decision-led**:

- **The developer remains the decision-maker.** AI can draft and execute, but it should not silently apply non-trivial changes.
- **Predictability is allowed; autonomy is not.** Small, bounded edits can be streamlined; large edits require explicit human intent.
- **Enterprise/IP defensibility.** Maintain a clear trail of human decisions + verification without logging code, prompts, or diffs.
- **Offline-capable.** Repo understanding and governance must work without network access at runtime.
- **Minimal divergence.** Changes are kept surgical so upstream Continue merges remain feasible.

## What’s Different From Stock Continue

### 1) Unique Extension Identity (Zero Collision With Stock Continue)

To avoid conflicts with the marketplace Continue extension:

- VS Code extension id: `devsherpa.devsherpa-continue`
- View ids renamed away from `continue.*`:
  - `devsherpa.devsherpaGUIView`
  - `devsherpa.devsherpaConsoleView`

### 2) RepoMap Context Provider (Deterministic Global Repo Understanding)

RepoMap provides a bounded, stable global view of a repo (tree, key files, symbols, hotspots) for chat/agent prompts.

- Sidecar generator: `tools/repomap/repomap.py`
- Runs locally (offline), bounded/deterministic output, and caches by repo root + git head.

### 3) Authorship Mode (Decision → Execution → Attribution)

Authorship Mode enforces human decision capture for non-trivial edits _at the apply/accept seams_ (not just as a prompt suggestion).

- Non-trivial edits require:
  - classification: `predictable` vs `design`
  - a short decision note
- Design-classified edits additionally capture:
  - approvals (who/what/when)
  - verification evidence (tests/benchmarks)
- Metadata-only logging (no code/diffs/prompts) to: `.DevSherpa_decision-log.jsonl`

Key settings (VS Code):

- `DevSherpa_authorshipMode_enabled`
- `DevSherpa_authorshipMode_autoApproveMaxChangedLines`
- `DevSherpa_authorshipMode_logPath` (default `.DevSherpa_decision-log.jsonl`)
- `DevSherpa_authorshipMode_requireDecisionForConfigFiles`
- `DevSherpa_authorshipMode_docsOnly` (docs-only execution mode)

### 4) Plan-Before-Execute (Human Markdown Plans + Scope Checks)

Plans are lightweight Markdown artifacts that capture intent before execution.

- Plans live in: `.DevSherpa_plans/YYYY-MM-DD_<slug>.md`
- Active plan pointer: `.DevSherpa_active-plan.json`
- Active Plan context provider injects a bounded, read-only view of the active plan.
- Execution-time plan checks warn/require acknowledgement for out-of-scope edits (additive to Authorship Mode).

### 5) Audit Tooling (Render + Schema + CI Gate)

Under `tools/decision-log/`:

- JSON Schema v2: `tools/decision-log/decision-log-schema-v2.json`
- Render to report: `tools/decision-log/decision-log-render.py`
- Migrate v1 → v2: `tools/decision-log/decision-log-migrate-v1-to-v2.py`
- CI gate: `tools/decision-log/decision-log-ci-check.py`

The CI gate can block merges when `design` entries lack approvals and verification evidence.

## What Remains Compatible With Continue

- Continue configuration still uses `.continue/config.yaml` and the standard Continue model/provider system.
- Most Continue UX and workflows remain intact; DevSherpa additions are layered on top and are fail-soft (do not crash chat/agent runs if files are missing/unwritable or git is unavailable).

## Packaging (VSIX)

This fork packages as a DevSherpa-branded VSIX (darwin-arm64):

```bash
pnpm -C extensions/vscode run package
```

Outputs:

- `extensions/vscode/build/devsherpa-continue-<version>.vsix`
- `extensions/vscode/build/devsherpa-continue-<version>-internal.vsix`

Node baseline: v20.x (per `extensions/vscode/package.json` `engines.node`).

## Philosophy (For “No Vibe Coding” Teams)

This fork is designed to make AI assistance safe for real engineering organizations:

- **Plans** capture pre-execution intent (human-authored).
- **Authorship Mode** gates execution (human decision required for non-trivial edits).
- **Decision logs** capture attribution + evidence (metadata-only).
- **Context providers** keep the assistant consistent with repo reality and prior decisions (bounded, deterministic).

The output of the system is not “trust the model”; it’s **trust the process**.
