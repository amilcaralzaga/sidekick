import * as path from "path";
import * as vscode from "vscode";

import { myersDiff } from "core/diff/myers";
import { localPathOrUriToPath } from "core/util/pathToUri";

export interface AuthorshipConfig {
  enabled: boolean;
  autoApproveMaxChangedLines: number;
  logPath: string;
  requireDecisionForConfigFiles: boolean;
  dirtyCacheTtlSeconds?: number;
}

export type Predictability = "predictable" | "design";

export interface ChangeSummary {
  fileUri: string;
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  changedLines: number;
  isConfigFile: boolean;
  isNewFile: boolean;
  isMultiFile: boolean;
}

export interface DecisionCaptureResult {
  decisionNote: string;
  predictability: Predictability;
  autoApproved: boolean;
}

const DEFAULT_AUTO_APPROVE_MAX = 15;
const DEFAULT_LOG_PATH = ".sidekick/decision-log.jsonl";

const CONFIG_FILE_BASENAMES = new Set([
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.base.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "requirements.txt",
  "pyproject.toml",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "Makefile",
  "CMakeLists.txt",
]);

const AUTO_APPROVE_NOTE = "Predictable/boilerplate edit (auto-approved)";

export const getAuthorshipConfig = (): AuthorshipConfig => {
  const config = vscode.workspace.getConfiguration("sidekick");
  return {
    enabled: config.get("authorshipMode.enabled", true),
    autoApproveMaxChangedLines: config.get(
      "authorshipMode.autoApproveMaxChangedLines",
      DEFAULT_AUTO_APPROVE_MAX,
    ),
    logPath: config.get("authorshipMode.logPath", DEFAULT_LOG_PATH),
    requireDecisionForConfigFiles: config.get(
      "authorshipMode.requireDecisionForConfigFiles",
      true,
    ),
  };
};

export const isConfigFilePath = (filePath: string) => {
  const basename = path.basename(filePath).toLowerCase();
  if (CONFIG_FILE_BASENAMES.has(basename)) {
    return true;
  }
  if (basename.startsWith("tsconfig") && basename.endsWith(".json")) {
    return true;
  }
  return false;
};

export const computeDiffStats = (oldContent: string, newContent: string) => {
  const diffs = myersDiff(oldContent, newContent);
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const diff of diffs) {
    if (diff.type === "new") {
      linesAdded += 1;
    } else if (diff.type === "old") {
      linesRemoved += 1;
    }
  }
  return { linesAdded, linesRemoved, changedLines: linesAdded + linesRemoved };
};

export const buildChangeSummary = ({
  fileUri,
  linesAdded,
  linesRemoved,
  isNewFile,
  isMultiFile,
}: {
  fileUri: string;
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  isMultiFile: boolean;
}): ChangeSummary => {
  const filePath = localPathOrUriToPath(fileUri);
  const isConfigFile = isConfigFilePath(filePath);
  const changedLines = Math.max(0, linesAdded) + Math.max(0, linesRemoved);
  return {
    fileUri,
    filePath,
    linesAdded,
    linesRemoved,
    changedLines,
    isConfigFile,
    isNewFile,
    isMultiFile,
  };
};

const shouldAutoApprove = (
  summary: ChangeSummary,
  config: AuthorshipConfig,
) => {
  if (!config.enabled) {
    return false;
  }
  if (summary.isNewFile) {
    return false;
  }
  if (summary.isMultiFile) {
    return false;
  }
  if (config.requireDecisionForConfigFiles && summary.isConfigFile) {
    return false;
  }
  if (summary.changedLines === 0) {
    return true;
  }
  return summary.changedLines <= config.autoApproveMaxChangedLines;
};

export const ensureDecisionForChange = async (
  summary: ChangeSummary,
  config: AuthorshipConfig,
  options?: { forceDecision?: boolean },
): Promise<DecisionCaptureResult | null> => {
  if (!config.enabled) {
    return null;
  }

  const forceDecision = options?.forceDecision ?? false;
  if (!forceDecision && shouldAutoApprove(summary, config)) {
    return {
      decisionNote: AUTO_APPROVE_NOTE,
      predictability: "predictable",
      autoApproved: true,
    };
  }

  const predictabilityPick = await vscode.window.showQuickPick(
    [
      {
        label: "Predictable",
        description: "Small, mechanical, or boilerplate change",
        value: "predictable" as Predictability,
      },
      {
        label: "Design / Creative",
        description: "Requires human judgment or architecture choice",
        value: "design" as Predictability,
      },
    ],
    {
      placeHolder: "Classify this change",
      ignoreFocusOut: true,
    },
  );

  if (!predictabilityPick) {
    return null;
  }

  const decisionNote = await vscode.window.showInputBox({
    prompt: "Decision note (why this approach?)",
    placeHolder: "e.g. Keep existing API shape; minimal change set.",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length < 8) {
        return "Please provide at least 8 characters.";
      }
      return undefined;
    },
  });

  if (!decisionNote) {
    return null;
  }

  return {
    decisionNote: decisionNote.trim(),
    predictability: predictabilityPick.value,
    autoApproved: false,
  };
};

export const formatCommitNote = (entry: {
  decisionNote: string;
  filesTouched?: string[];
  diffStats?: { linesAdded: number; linesRemoved: number };
}) => {
  const files = entry.filesTouched?.length
    ? `Files: ${entry.filesTouched.join(", ")}`
    : "";
  const stats = entry.diffStats
    ? `(+${entry.diffStats.linesAdded}/-${entry.diffStats.linesRemoved})`
    : "";

  const lines = [
    `Decision: ${entry.decisionNote}`,
    "AI assisted draft; human selected approach and reviewed/applied.",
  ];

  if (files || stats) {
    lines.push(`${files} ${stats}`.trim());
  }

  return lines.join("\n");
};
