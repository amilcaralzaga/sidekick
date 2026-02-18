import * as path from "path";
import * as vscode from "vscode";

import { myersDiff } from "core/diff/myers";
import { localPathOrUriToPath } from "core/util/pathToUri";
import {
  getActivePlanPath,
  getWorkspaceRootPath,
  readPlanInfo,
} from "../plans/PlanStore";

export interface AuthorshipConfig {
  enabled: boolean;
  autoApproveMaxChangedLines: number;
  logPath: string;
  requireDecisionForConfigFiles: boolean;
  dirtyCacheTtlSeconds?: number;
  docsOnly: boolean;
}

export type Predictability = "predictable" | "design";

export interface ChangeSummary {
  fileUri: string;
  filePath: string;
  linesAdded: number;
  linesRemoved: number;
  changedLines: number;
  isConfigFile: boolean;
  isRendererFile: boolean;
  isNewFile: boolean;
  isMultiFile: boolean;
  isRename: boolean;
}

export interface DecisionCaptureResult {
  decisionNote: string;
  predictability: Predictability;
  autoApproved: boolean;
  planPath?: string;
  planTitle?: string;
  outOfScopePaths?: string[];
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

const DEFAULT_AUTO_APPROVE_MAX = 15;
const DEFAULT_LOG_PATH = ".devsherpa/decision-log.jsonl";
const NON_TRIVIAL_MAX_LINES = 20;

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

const RENDERER_PATH_KEYWORDS = ["renderer", "rendering", "render-engine"];

const DOC_FILE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".markdown",
  ".rst",
  ".adoc",
  ".txt",
]);

const AUTO_APPROVE_NOTE = "Predictable/boilerplate edit (auto-approved)";
const OUT_OF_SCOPE_HINT = "Out-of-scope:";

export const getAuthorshipConfig = (): AuthorshipConfig => {
  const config = vscode.workspace.getConfiguration();
  return {
    enabled: config.get("DevSherpa_authorshipMode_enabled", true),
    autoApproveMaxChangedLines: config.get(
      "DevSherpa_authorshipMode_autoApproveMaxChangedLines",
      DEFAULT_AUTO_APPROVE_MAX,
    ),
    logPath: config.get("DevSherpa_authorshipMode_logPath", DEFAULT_LOG_PATH),
    requireDecisionForConfigFiles: config.get(
      "DevSherpa_authorshipMode_requireDecisionForConfigFiles",
      true,
    ),
    docsOnly: config.get("DevSherpa_authorshipMode_docsOnly", false),
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

export const isRendererPath = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  const segments = normalized.split("/").filter(Boolean);
  return segments.some((segment) =>
    RENDERER_PATH_KEYWORDS.some((keyword) => segment.includes(keyword)),
  );
};

export const isDocFilePath = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, "/");
  const basename = path.basename(normalized).toLowerCase();
  if (basename.startsWith("readme")) {
    return true;
  }
  const ext = path.extname(basename).toLowerCase();
  return DOC_FILE_EXTENSIONS.has(ext);
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
  isRename = false,
}: {
  fileUri: string;
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  isMultiFile: boolean;
  isRename?: boolean;
}): ChangeSummary => {
  const filePath = localPathOrUriToPath(fileUri);
  const isConfigFile = isConfigFilePath(filePath);
  const isRendererFile = isRendererPath(filePath);
  const changedLines = Math.max(0, linesAdded) + Math.max(0, linesRemoved);
  return {
    fileUri,
    filePath,
    linesAdded,
    linesRemoved,
    changedLines,
    isConfigFile,
    isRendererFile,
    isNewFile,
    isMultiFile,
    isRename,
  };
};

const isNonTrivialChange = (summary: ChangeSummary) => {
  if (summary.isNewFile || summary.isRename || summary.isMultiFile) {
    return true;
  }
  if (summary.isConfigFile || summary.isRendererFile) {
    return true;
  }
  return summary.changedLines > NON_TRIVIAL_MAX_LINES;
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
  if (summary.isRename) {
    return false;
  }
  if (summary.isMultiFile) {
    return false;
  }
  if (summary.isConfigFile) {
    return false;
  }
  if (summary.isRendererFile) {
    return false;
  }
  if (summary.changedLines === 0) {
    return true;
  }
  if (summary.changedLines > NON_TRIVIAL_MAX_LINES) {
    return false;
  }
  const maxAutoApprove = Math.min(
    config.autoApproveMaxChangedLines,
    NON_TRIVIAL_MAX_LINES,
  );
  return summary.changedLines <= maxAutoApprove;
};

const normalizeRelPath = (value: string) => {
  return value.replace(/\\/g, "/").replace(/^\.?\//, "");
};

const globToRegExp = (pattern: string) => {
  const escaped = pattern
    .replace(/\\/g, "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§DOUBLESTAR§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§DOUBLESTAR§§/g, ".*");
  return new RegExp(`^${escaped}$`);
};

const matchesScope = (filePath: string, scopeItems: string[]) => {
  if (!scopeItems.length) {
    return null;
  }
  const normalized = normalizeRelPath(filePath);
  for (const raw of scopeItems) {
    const scope = normalizeRelPath(raw.trim());
    if (!scope) {
      continue;
    }
    if (scope.includes("*")) {
      const regex = globToRegExp(scope);
      if (regex.test(normalized)) {
        return true;
      }
    } else {
      if (
        normalized === scope ||
        normalized.startsWith(`${scope}/`) ||
        (scope.endsWith("/") && normalized.startsWith(scope))
      ) {
        return true;
      }
    }
  }
  return false;
};

export const ensureDecisionForChange = async (
  summary: ChangeSummary,
  config: AuthorshipConfig,
  options?: {
    forceDecision?: boolean;
    filesTouched?: string[];
    repoRootPath?: string;
  },
): Promise<DecisionCaptureResult | null> => {
  const repoRootPath =
    options?.repoRootPath ?? getWorkspaceRootPath(summary.fileUri) ?? "";
  const planPath = repoRootPath ? getActivePlanPath(repoRootPath) : null;
  const planInfo =
    planPath && repoRootPath ? readPlanInfo(repoRootPath, planPath) : null;

  const touchedPaths =
    options?.filesTouched?.length && options.filesTouched.length > 0
      ? options.filesTouched
      : [summary.filePath];

  if (config.docsOnly) {
    const nonDocPaths = touchedPaths.filter(
      (filePath) => !isDocFilePath(filePath),
    );
    if (nonDocPaths.length) {
      const preview = nonDocPaths.slice(0, 10).join(", ");
      await vscode.window.showWarningMessage(
        `Docs-only mode is enabled. This change touches non-documentation files: ${preview}`,
        { modal: true },
        "Cancel",
      );
      return null;
    }
  }

  if (!config.enabled) {
    return {
      decisionNote: "",
      predictability: "predictable",
      autoApproved: true,
      planPath: planInfo?.path,
      planTitle: planInfo?.title,
    };
  }

  const forceDecision = options?.forceDecision ?? false;
  if (!forceDecision && shouldAutoApprove(summary, config)) {
    return {
      decisionNote: AUTO_APPROVE_NOTE,
      predictability: "predictable",
      autoApproved: true,
      planPath: planInfo?.path,
      planTitle: planInfo?.title,
    };
  }

  const isNonTrivial = isNonTrivialChange(summary);
  let outOfScopePaths: string[] = [];
  if (isNonTrivial) {
    if (!planInfo) {
      const selection = await vscode.window.showWarningMessage(
        "No active plan set for this non-trivial change.",
        "Create Plan",
        "Set Active Plan",
      );
      if (selection === "Create Plan") {
        void vscode.commands.executeCommand("DevSherpa_newPlan");
      } else if (selection === "Set Active Plan") {
        void vscode.commands.executeCommand("DevSherpa_setActivePlan");
      }
    } else if (!planInfo.scopeItems.length) {
      void vscode.window.showWarningMessage(
        "Active plan has no scope entries; cannot validate scope.",
      );
    } else {
      const normalized = touchedPaths.map(normalizeRelPath);
      outOfScopePaths = normalized.filter(
        (filePath) => matchesScope(filePath, planInfo.scopeItems) === false,
      );
      if (outOfScopePaths.length) {
        const preview = outOfScopePaths.slice(0, 10).join(", ");
        const proceed = await vscode.window.showWarningMessage(
          `Out of scope for active plan: ${preview}`,
          { modal: true },
          "Proceed (Design)",
          "Cancel",
        );
        if (proceed !== "Proceed (Design)") {
          return null;
        }
      }
    }
  }

  const forcedDesign = outOfScopePaths.length > 0;
  const forcedPredictability: Predictability | null = forcedDesign
    ? "design"
    : null;

  let predictabilityValue: Predictability | null = forcedPredictability;
  if (!predictabilityValue) {
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
    predictabilityValue = predictabilityPick.value;
  }

  const planTitle = planInfo?.title;
  const planNotePrefix =
    predictabilityValue === "design" && planTitle
      ? `Per plan: ${planTitle}`
      : "";
  const outOfScopePrefix = outOfScopePaths.length
    ? `${OUT_OF_SCOPE_HINT} ${outOfScopePaths.slice(0, 3).join(", ")}`
    : "";

  const defaultNote = [outOfScopePrefix, planNotePrefix]
    .filter(Boolean)
    .join(" ");

  const decisionNote = await vscode.window.showInputBox({
    prompt: "Decision note (why this approach?)",
    placeHolder: "e.g. Keep existing API shape; minimal change set.",
    value: defaultNote,
    ignoreFocusOut: true,
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length < 8) {
        return "Please provide at least 8 characters.";
      }
      if (
        outOfScopePaths.length > 0 &&
        !trimmed.toLowerCase().includes("out-of-scope")
      ) {
        return "Please acknowledge out-of-scope intent in the note.";
      }
      return undefined;
    },
  });

  if (!decisionNote) {
    return null;
  }

  let approvals: DecisionCaptureResult["approvals"];
  let verification: DecisionCaptureResult["verification"];
  if (predictabilityValue === "design") {
    const approvalBy = await vscode.window.showInputBox({
      prompt: "Approval (who approved this design change?)",
      placeHolder: "e.g. Alice (Tech Lead)",
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (value.trim().length < 3) {
          return "Please provide an approver name or role.";
        }
        return undefined;
      },
    });
    if (!approvalBy) {
      return null;
    }

    const approvalEvidence = await vscode.window.showInputBox({
      prompt: "Approval evidence (link, ticket, or note)",
      placeHolder: "e.g. JIRA-1234, PR comment link, or short note",
      ignoreFocusOut: true,
      validateInput: (value) => {
        if (value.trim().length < 3) {
          return "Please provide brief approval evidence.";
        }
        return undefined;
      },
    });
    if (!approvalEvidence) {
      return null;
    }

    approvals = [
      {
        by: approvalBy.trim(),
        decision: "approved",
        timestamp: new Date().toISOString(),
        evidence: approvalEvidence.trim(),
      },
    ];

    const testsInput = await vscode.window.showInputBox({
      prompt: "Verification tests (comma-separated, at least one)",
      placeHolder: "e.g. unit:PixelLoaderTests, integration:SliceLoadPerf",
      ignoreFocusOut: true,
      validateInput: (value) => {
        const items = value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
        if (items.length === 0) {
          return "Provide at least one test or benchmark.";
        }
        return undefined;
      },
    });
    if (!testsInput) {
      return null;
    }
    const tests = testsInput
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    const benchmarksInput = await vscode.window.showInputBox({
      prompt: "Benchmarks (optional, comma-separated)",
      placeHolder: "e.g. preload_latency_ms:-35%",
      ignoreFocusOut: true,
    });
    const benchmarks = (benchmarksInput ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);

    verification = { tests, benchmarks };
  }

  return {
    decisionNote: decisionNote.trim(),
    predictability: predictabilityValue,
    autoApproved: false,
    planPath: planInfo?.path,
    planTitle: planInfo?.title,
    outOfScopePaths: outOfScopePaths.length ? outOfScopePaths : undefined,
    approvals,
    verification,
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
