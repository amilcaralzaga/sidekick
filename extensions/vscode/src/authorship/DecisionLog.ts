import { exec } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as path from "path";

import type { IDE } from "core";
import { localPathOrUriToPath } from "core/util/pathToUri";
import * as vscode from "vscode";

import { getAuthorshipConfig } from "./authorship";

export type Predictability = "predictable" | "design";

export interface DecisionLogEntry {
  timestamp: string;
  workspaceRoot: string;
  repoRoot: string;
  gitHead: string;
  operationType: string;
  predictability: Predictability;
  decisionNote: string;
  filesTouched: string[];
  planPath?: string;
  planTitle?: string;
  diffStats: {
    linesAdded: number;
    linesRemoved: number;
  };
  aiActionSummary: string;
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

  async record(
    entry: Omit<
      DecisionLogEntry,
      "timestamp" | "workspaceRoot" | "repoRoot" | "gitHead"
    >,
    fileUri?: string,
  ): Promise<void> {
    try {
      const { repoRootPath, workspaceRootPath, gitHead } =
        await this.resolveRepoInfo(fileUri);
      const config = getAuthorshipConfig();
      const logPath = this.resolveLogPath(repoRootPath, config.logPath);
      if (!logPath) {
        return;
      }
      fs.mkdirSync(path.dirname(logPath), { recursive: true });

      const sanitizedEntry: DecisionLogEntry = {
        timestamp: new Date().toISOString(),
        workspaceRoot: sanitizeField(workspaceRootPath),
        repoRoot: sanitizeField(repoRootPath),
        gitHead: sanitizeField(gitHead),
        operationType: sanitizeField(entry.operationType),
        predictability: entry.predictability,
        decisionNote: sanitizeField(entry.decisionNote),
        filesTouched: (entry.filesTouched ?? []).map(sanitizeField),
        planPath: sanitizeField(entry.planPath),
        planTitle: sanitizeField(entry.planTitle),
        diffStats: {
          linesAdded: Math.max(0, entry.diffStats?.linesAdded ?? 0),
          linesRemoved: Math.max(0, entry.diffStats?.linesRemoved ?? 0),
        },
        aiActionSummary: sanitizeField(entry.aiActionSummary),
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

  async readRecent(n: number, fileUri?: string): Promise<DecisionLogEntry[]> {
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
      const entries: DecisionLogEntry[] = [];
      for (const line of slice) {
        try {
          entries.push(JSON.parse(line));
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
    const defaultPath = ".sidekick/decision-log.jsonl";
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
    if (repoRootPath) {
      gitHead = await execAsync("git rev-parse HEAD", repoRootPath);
    }

    return { repoRootPath, workspaceRootPath, gitHead };
  }
}
