import * as fs from "fs";
import * as path from "path";

import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
} from "../../index.js";
import { localPathOrUriToPath } from "../../util/pathToUri.js";
import { BaseContextProvider } from "../index.js";

const DEFAULT_LOG_RELATIVE_PATH = ".DevSherpa_decision-log.jsonl";
const DEFAULT_MAX_ENTRIES = 10;
const MAX_ENTRIES_CAP = 25;
const MAX_NOTE_CHARS = 180;
const DEFAULT_MAX_TAIL_BYTES = 2 * 1024 * 1024;

interface DecisionLogOptions {
  /** Workspace-relative or absolute path to the decision log file. */
  logPath?: string;
  /** Maximum entries to include (hard capped). */
  maxEntries?: number;
  /** Max bytes to read from the end of the file (best-effort). */
  maxTailBytes?: number;
}

type DecisionLogEntry = {
  timestamp?: string;
  predictability?: "predictable" | "design" | string;
  decisionNote?: string;
  classification?: { predictability?: "predictable" | "design" | string };
  rationale?: { decisionNote?: string };
};

const toNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

const clamp = (value: number, min: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
};

const trimTo = (value: string, limit: number): string => {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}…`;
};

const resolveLogPath = (repoRootPath: string, options?: DecisionLogOptions) => {
  const configured = options?.logPath?.trim();
  if (!configured) {
    return path.join(repoRootPath, DEFAULT_LOG_RELATIVE_PATH);
  }
  if (path.isAbsolute(configured)) {
    return configured;
  }
  return path.join(repoRootPath, configured);
};

const getRepoRootPath = async (
  extras: ContextProviderExtras,
): Promise<string | null> => {
  let workspaceRootUri: string | undefined;
  try {
    const dirs = await extras.ide.getWorkspaceDirs();
    workspaceRootUri = dirs?.[0];
  } catch {
    return null;
  }
  if (!workspaceRootUri) {
    return null;
  }

  let repoRootUri = workspaceRootUri;
  try {
    const gitRoot = await extras.ide.getGitRootPath(workspaceRootUri);
    if (gitRoot) {
      repoRootUri = gitRoot;
    }
  } catch {
    // ignore git root resolution errors
  }

  return localPathOrUriToPath(repoRootUri);
};

const readTailText = (filePath: string, maxTailBytes: number): string => {
  const fd = fs.openSync(filePath, "r");
  try {
    const stats = fs.fstatSync(fd);
    const size = stats.size ?? 0;
    if (size <= 0) {
      return "";
    }
    const bytesToRead = Math.min(size, maxTailBytes);
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, size - bytesToRead);
    return buffer.toString("utf8");
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore close errors
    }
  }
};

const parseRecentEntries = (
  jsonlTailText: string,
  maxEntries: number,
): DecisionLogEntry[] => {
  // Parse from the end for deterministic "most recent first" ordering.
  const lines = jsonlTailText.split(/\r?\n/);
  const results: DecisionLogEntry[] = [];
  for (let i = lines.length - 1; i >= 0 && results.length < maxEntries; i--) {
    const raw = lines[i]?.trim();
    if (!raw) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw) as DecisionLogEntry;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }
      results.push(parsed);
    } catch {
      // skip malformed lines
    }
  }
  return results;
};

const getPredictability = (entry: DecisionLogEntry): string => {
  return (
    entry.classification?.predictability ?? entry.predictability ?? "unknown"
  );
};

const getDecisionNote = (entry: DecisionLogEntry): string => {
  return entry.rationale?.decisionNote ?? entry.decisionNote ?? "";
};

const formatEntryLine = (entry: DecisionLogEntry): string | null => {
  if (!entry.timestamp || typeof entry.timestamp !== "string") {
    return null;
  }
  const date = new Date(entry.timestamp);
  if (!Number.isFinite(date.getTime())) {
    return null;
  }
  const dateString = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const pred = getPredictability(entry);
  const predictability =
    pred === "design"
      ? "(Design)"
      : pred === "predictable"
        ? "(Predictable)"
        : "(Unknown)";
  const note = getDecisionNote(entry);
  const noteTrimmed = trimTo(note, MAX_NOTE_CHARS);
  if (!noteTrimmed) {
    return `[${dateString}] ${predictability} Note: (empty)`;
  }
  return `[${dateString}] ${predictability} Note: ${noteTrimmed}`;
};

/**
 * Read-only provider that surfaces recent, human-authored decision notes from
 * `.DevSherpa_decision-log.jsonl` to keep AI behavior consistent with prior choices.
 *
 * Fail-soft: if the file is missing or malformed, returns no context.
 * Non-normative: entries are presented verbatim (trimmed only).
 */
class DecisionLogContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "decision-log",
    displayTitle: "Authorship Decisions",
    description: "Recent human decision notes from the workspace decision log",
    type: "normal",
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    const repoRootPath = await getRepoRootPath(extras);
    if (!repoRootPath) {
      return [];
    }

    const options = this.options as DecisionLogOptions | undefined;
    const maxEntries = clamp(
      toNumber(options?.maxEntries, DEFAULT_MAX_ENTRIES),
      1,
      MAX_ENTRIES_CAP,
    );
    const maxTailBytes = clamp(
      toNumber(options?.maxTailBytes, DEFAULT_MAX_TAIL_BYTES),
      16 * 1024,
      DEFAULT_MAX_TAIL_BYTES,
    );

    const logPath = resolveLogPath(repoRootPath, options);
    try {
      if (!fs.existsSync(logPath)) {
        return [];
      }
      const stat = fs.statSync(logPath);
      if (!stat.isFile()) {
        return [];
      }
    } catch {
      return [];
    }

    try {
      const tailText = readTailText(logPath, maxTailBytes);
      if (!tailText.trim()) {
        return [];
      }

      const recentEntries = parseRecentEntries(tailText, maxEntries);
      const lines: string[] = [];
      for (const entry of recentEntries) {
        const line = formatEntryLine(entry);
        if (line) {
          lines.push(line);
        }
      }
      if (!lines.length) {
        return [];
      }

      return [
        {
          name: "Authorship History",
          description: "Recent human decision notes (read-only)",
          content: lines.join("\n"),
        },
      ];
    } catch {
      return [];
    }
  }
}

export default DecisionLogContextProvider;
