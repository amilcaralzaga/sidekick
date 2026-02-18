import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as path from "path";

import type { IDE } from "core";
import { localPathOrUriToPath } from "core/util/pathToUri";
import * as vscode from "vscode";

import { getAuthorshipConfig, isDocFilePath } from "./authorship";

export type Predictability = "predictable" | "design";

export interface DecisionLogEntryV2 {
  id: string;
  timestamp: string;
  workspaceRoot: string;
  repoRoot: string;
  git: {
    headBefore: string | null;
    headAfter: string | null;
    branch: string | null;
    dirty: boolean | null;
  };
  operation: {
    type: string;
    operationType: string;
  };
  change: {
    filesTouched: string[];
    diffStats: {
      linesAdded: number;
      linesRemoved: number;
    };
  };
  classification: {
    predictability: Predictability | "unknown";
    impact: "low" | "medium" | "high" | "unknown";
    riskDomains: string[];
    safetyCritical: boolean | null;
  };
  rationale: {
    decisionNote: string;
    aiActionSummary: string;
    planPath?: string;
    planTitle?: string;
  };
  verification: {
    tests: string[];
    benchmarks: string[];
  };
  approvals: Array<{
    by?: string;
    role?: string;
    decision?: string;
    timestamp?: string;
    evidence?: string;
  }>;
  traceability: {
    requirements: string[];
    risks: string[];
    tickets: string[];
  };
}

export interface DecisionLogInput {
  operationType: string;
  predictability: Predictability;
  decisionNote: string;
  filesTouched: string[];
  diffStats: {
    linesAdded: number;
    linesRemoved: number;
  };
  aiActionSummary: string;
  planPath?: string;
  planTitle?: string;
  approvals?: Array<{
    by: string;
    role?: string;
    decision?: string;
    timestamp?: string;
    evidence?: string;
  }>;
  verification?: {
    tests: string[];
    benchmarks: string[];
  };
}

export interface DecisionLogSummary {
  timestamp?: string;
  predictability?: Predictability | "unknown";
  decisionNote?: string;
  filesTouched?: string[];
  diffStats?: {
    linesAdded: number;
    linesRemoved: number;
  };
  planPath?: string;
  planTitle?: string;
}

const MAX_FIELD_LENGTH = 500;

const trimField = (value: string, maxLength = MAX_FIELD_LENGTH) => {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxLength)}…`;
};

const redactLikelySecrets = (value: string) => {
  let redacted = value;
  redacted = redacted.replace(
    /(api[_-]?key|secret|token|password)\s*[:=]\s*[^\s]+/gi,
    "$1=[redacted]",
  );
  redacted = redacted.replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[redacted]");
  return redacted;
};

const sanitizeField = (value?: string) => {
  if (!value) {
    return "";
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return trimField(redactLikelySecrets(normalized));
};

const execAsync = (command: string, cwd: string): Promise<string> => {
  return new Promise((resolve) => {
    exec(command, { cwd }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }
      resolve(stdout?.toString().trim() ?? "");
    });
  });
};

const normalizePath = (value: string) => value.replace(/\\/g, "/");

const inferRiskDomains = (filesTouched: string[]) => {
  const domains = new Set<string>();
  for (const rawPath of filesTouched) {
    const filePath = normalizePath(rawPath);
    if (filePath.includes("CoreDICOM/")) {
      domains.add("correctness");
      domains.add("performance");
      domains.add("thread-safety");
      domains.add("memory");
    }
    if (filePath.includes("Views/")) {
      domains.add("ui");
      domains.add("workflow");
    }
    if (isDocFilePath(filePath)) {
      domains.add("documentation");
    }
  }
  return Array.from(domains);
};

const inferImpact = (
  filesTouched: string[],
  diffStats: { linesAdded: number; linesRemoved: number },
): "low" | "medium" | "high" | "unknown" => {
  const totalChanged =
    Math.max(0, diffStats.linesAdded) + Math.max(0, diffStats.linesRemoved);
  if (!filesTouched.length && totalChanged === 0) {
    return "unknown";
  }
  const normalized = filesTouched.map(normalizePath);
  const allDocs =
    normalized.length > 0 &&
    normalized.every((filePath) => isDocFilePath(filePath));
  if (allDocs) {
    return totalChanged >= 50 ? "medium" : "low";
  }
  if (normalized.some((filePath) => filePath.includes("CoreDICOM/"))) {
    return "high";
  }
  if (normalized.some((filePath) => filePath.includes("Views/"))) {
    return totalChanged >= 50 ? "high" : "medium";
  }
  if (totalChanged >= 100) {
    return "high";
  }
  if (totalChanged >= 30) {
    return "medium";
  }
  return "low";
};

const toFsPath = (uriOrPath: string) => {
  if (!uriOrPath) {
    return "";
  }
  if (uriOrPath.startsWith("file://")) {
    try {
      return fileURLToPath(uriOrPath);
    } catch {
      return localPathOrUriToPath(uriOrPath);
    }
  }
  return uriOrPath;
};

export class DecisionLog {
  constructor(private readonly ide: IDE) {}

  async record(entry: DecisionLogInput, fileUri?: string): Promise<void> {
    try {
      const { repoRootPath, workspaceRootPath, gitHead, gitBranch, gitDirty } =
        await this.resolveRepoInfo(fileUri);
      const config = getAuthorshipConfig();
      const logPath = this.resolveLogPath(repoRootPath, config.logPath);
      if (!logPath) {
        return;
      }
      fs.mkdirSync(path.dirname(logPath), { recursive: true });

      const safeFiles = (entry.filesTouched ?? []).map(sanitizeField);
      const diffStats = {
        linesAdded: Math.max(0, entry.diffStats?.linesAdded ?? 0),
        linesRemoved: Math.max(0, entry.diffStats?.linesRemoved ?? 0),
      };

      const sanitizedEntry: DecisionLogEntryV2 = {
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        workspaceRoot: sanitizeField(workspaceRootPath),
        repoRoot: sanitizeField(repoRootPath),
        git: {
          headBefore: sanitizeField(gitHead) || null,
          headAfter: sanitizeField(gitHead) || null,
          branch: sanitizeField(gitBranch) || null,
          dirty: typeof gitDirty === "boolean" ? gitDirty : null,
        },
        operation: {
          type: sanitizeField(entry.operationType),
          operationType: sanitizeField(entry.operationType),
        },
        change: {
          filesTouched: safeFiles,
          diffStats,
        },
        classification: {
          predictability: entry.predictability ?? "unknown",
          impact: inferImpact(safeFiles, diffStats),
          riskDomains: inferRiskDomains(safeFiles),
          safetyCritical: null,
        },
        rationale: {
          decisionNote: sanitizeField(entry.decisionNote),
          aiActionSummary: sanitizeField(entry.aiActionSummary),
          planPath: sanitizeField(entry.planPath),
          planTitle: sanitizeField(entry.planTitle),
        },
        verification: {
          tests: entry.verification?.tests ?? [],
          benchmarks: entry.verification?.benchmarks ?? [],
        },
        approvals: entry.approvals ?? [],
        traceability: {
          requirements: [],
          risks: [],
          tickets: [],
        },
      };

      fs.appendFileSync(
        logPath,
        `${JSON.stringify(sanitizedEntry)}\n`,
        "utf-8",
      );
    } catch {
      // Fail-soft: never block core flows
    }
  }

  async readRecent(n: number, fileUri?: string): Promise<DecisionLogSummary[]> {
    try {
      const { repoRootPath } = await this.resolveRepoInfo(fileUri);
      const config = getAuthorshipConfig();
      const logPath = this.resolveLogPath(repoRootPath, config.logPath);
      if (!logPath || !fs.existsSync(logPath)) {
        return [];
      }
      const raw = fs.readFileSync(logPath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const slice = lines.slice(-n);
      const entries: DecisionLogSummary[] = [];
      for (const line of slice) {
        try {
          const parsed = JSON.parse(line);
          if (!parsed || typeof parsed !== "object") {
            continue;
          }
          const isV2 = Boolean(
            parsed.classification || parsed.rationale || parsed.change,
          );
          if (isV2) {
            entries.push({
              timestamp: parsed.timestamp,
              predictability: parsed.classification?.predictability,
              decisionNote: parsed.rationale?.decisionNote,
              filesTouched: parsed.change?.filesTouched,
              diffStats: parsed.change?.diffStats,
              planPath: parsed.rationale?.planPath,
              planTitle: parsed.rationale?.planTitle,
            });
          } else {
            entries.push({
              timestamp: parsed.timestamp,
              predictability: parsed.predictability,
              decisionNote: parsed.decisionNote,
              filesTouched: parsed.filesTouched,
              diffStats: parsed.diffStats,
              planPath: parsed.planPath,
              planTitle: parsed.planTitle,
            });
          }
        } catch {
          // skip
        }
      }
      return entries;
    } catch {
      return [];
    }
  }

  private resolveLogPath(
    repoRootPath: string,
    logPath?: string,
  ): string | null {
    const defaultPath = ".devsherpa/decision-log.jsonl";
    const desired = logPath?.trim() || defaultPath;
    if (!repoRootPath) {
      return null;
    }
    if (path.isAbsolute(desired)) {
      return desired;
    }
    return path.join(repoRootPath, desired);
  }

  private async resolveRepoInfo(fileUri?: string): Promise<{
    repoRootPath: string;
    workspaceRootPath: string;
    gitHead: string;
    gitBranch: string;
    gitDirty: boolean | null;
  }> {
    const workspaceDirs = await this.ide.getWorkspaceDirs();
    let workspaceRootUri = workspaceDirs[0] ?? "";

    if (fileUri) {
      const folder = vscode.workspace.getWorkspaceFolder(
        vscode.Uri.parse(fileUri),
      );
      if (folder?.uri) {
        workspaceRootUri = folder.uri.toString();
      }
    }

    let repoRootUri = "";
    try {
      if (workspaceRootUri) {
        repoRootUri = (await this.ide.getGitRootPath(workspaceRootUri)) ?? "";
      }
    } catch {
      repoRootUri = "";
    }

    const repoRootPath = toFsPath(repoRootUri || workspaceRootUri);
    const workspaceRootPath = toFsPath(workspaceRootUri);

    let gitHead = "";
    let gitBranch = "";
    let gitDirty: boolean | null = null;
    if (repoRootPath) {
      gitHead = await execAsync("git rev-parse HEAD", repoRootPath);
      gitBranch = await execAsync(
        "git rev-parse --abbrev-ref HEAD",
        repoRootPath,
      );
      const dirtyStatus = await execAsync(
        "git status --porcelain",
        repoRootPath,
      );
      if (dirtyStatus !== "") {
        gitDirty = true;
      } else if (dirtyStatus === "") {
        gitDirty = false;
      }
    }

    return { repoRootPath, workspaceRootPath, gitHead, gitBranch, gitDirty };
  }
}
