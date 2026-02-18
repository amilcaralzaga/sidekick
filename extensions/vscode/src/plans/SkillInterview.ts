import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { Core } from "core/core";

import type { PlanInterviewResult } from "./PlanInterview";

type PlanSectionId = "intent" | "scope" | "approach" | "nonGoals" | "risks";

interface InterviewQuestion {
  id: PlanSectionId;
  question: string;
}

interface RepoMapJson {
  top_files?: Array<{ path: string; reason: string }>;
  symbols?: Array<{ name: string; kind: string; path: string; line: number }>;
}

type WorkType = "new-samd" | "add-feature" | "modify-feature";

export interface RepoInterviewContext {
  repoRootPath: string;
  recommendation: "general" | "skill";
  recommendationReasons: string[];
  suggestedScope: string[];
  repoMap?: RepoMapJson;
}

export interface SkillInterviewResult extends PlanInterviewResult {
  record: {
    schemaVersion: "1.0";
    createdAt: string;
    repoRootPath: string;
    workType: WorkType;
    goal: string;
    title: string;
    recommendation: RepoInterviewContext["recommendation"];
    recommendationReasons: string[];
    answers: Record<PlanSectionId, string>;
    repoHints: {
      topFiles: string[];
      symbols: string[];
    };
  };
}

const MAX_TITLE_LENGTH = 120;
const MAX_SECTION_CHARS = 600;
const MAX_BULLETS = 8;
const MAX_BULLET_CHARS = 180;
const MAX_HINT_FILES = 12;
const MAX_HINT_SYMBOLS = 10;
const REPO_MAP_TIMEOUT_MS = 8_000;

const SECTION_ORDER: PlanSectionId[] = [
  "intent",
  "scope",
  "approach",
  "nonGoals",
  "risks",
];

const DEFAULT_QUESTIONS: InterviewQuestion[] = [
  {
    id: "intent",
    question: "What outcome is this skill change intended to achieve?",
  },
  {
    id: "scope",
    question: "What files or modules are in scope for this change?",
  },
  {
    id: "approach",
    question: "How should this be implemented and validated?",
  },
  { id: "nonGoals", question: "What is explicitly out of scope?" },
  {
    id: "risks",
    question: "What risks should reviewers monitor during implementation?",
  },
];

const trimToLength = (value: string, max: number) => {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
};

const sanitizeTitle = (title: string) => {
  const trimmed = title.trim();
  if (!trimmed) {
    return "Untitled Plan";
  }
  if (trimmed.length <= MAX_TITLE_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_TITLE_LENGTH)}…`;
};

const splitBullets = (value: string) =>
  value
    .split(/\r?\n|,|;/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, MAX_BULLETS)
    .map((item) => trimToLength(item, MAX_BULLET_CHARS));

const formatParagraph = (value: string) => {
  if (!value.trim()) {
    return "<one paragraph>";
  }
  return trimToLength(value.replace(/\s+/g, " "), MAX_SECTION_CHARS);
};

const formatBullets = (value: string, placeholder: string) => {
  const items = splitBullets(value);
  if (!items.length) {
    return `- ${placeholder}`;
  }
  return items.map((item) => `- ${item}`).join("\n");
};

const buildPlanContent = (
  title: string,
  answers: Record<PlanSectionId, string>,
  workType: WorkType,
) => {
  const sanitizedTitle = sanitizeTitle(title);
  const intent = formatParagraph(answers.intent);
  return `# Plan: ${sanitizedTitle}

## Intent
${intent}

Work type: ${workType}

## Scope
${formatBullets(answers.scope, "<paths or bullets>")}

## Approach
${formatBullets(answers.approach, "<bullets>")}

## Non-goals
${formatBullets(answers.nonGoals, "<bullets>")}

## Risks
${formatBullets(answers.risks, "<bullets>")}
`;
};

const extractJsonObject = (raw: string) => {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return raw.slice(start, end + 1);
};

const coerceQuestions = (
  payload: any,
  fallback: InterviewQuestion[],
): { titleSuggestion?: string; questions: InterviewQuestion[] } => {
  const titleSuggestion =
    typeof payload?.titleSuggestion === "string"
      ? trimToLength(payload.titleSuggestion, MAX_TITLE_LENGTH)
      : undefined;
  const questions = new Map<PlanSectionId, string>();
  if (Array.isArray(payload?.questions)) {
    for (const entry of payload.questions) {
      if (
        entry &&
        typeof entry.id === "string" &&
        typeof entry.question === "string"
      ) {
        const id = entry.id as PlanSectionId;
        if (SECTION_ORDER.includes(id)) {
          questions.set(id, trimToLength(entry.question, 180));
        }
      }
    }
  }
  return {
    titleSuggestion,
    questions: SECTION_ORDER.map((id) => ({
      id,
      question:
        questions.get(id) ??
        fallback.find((item) => item.id === id)?.question ??
        "Provide details.",
    })),
  };
};

const detectRecommendation = (repoMap?: RepoMapJson) => {
  if (!repoMap) {
    return {
      recommendation: "general" as const,
      recommendationReasons: [],
      suggestedScope: [],
    };
  }
  const pathSignals = new Set<string>();
  const symbolSignals = new Set<string>();
  const skillTokens = ["skill", "workflow", "plugin", "orchestrator", "sherpa"];
  const topFiles = (repoMap.top_files ?? []).slice(0, MAX_HINT_FILES);
  const symbols = (repoMap.symbols ?? []).slice(0, 80);

  for (const file of topFiles) {
    const low = file.path.toLowerCase();
    for (const token of skillTokens) {
      if (low.includes(token)) {
        pathSignals.add(token);
      }
    }
  }
  for (const symbol of symbols) {
    const low = `${symbol.name} ${symbol.path}`.toLowerCase();
    for (const token of skillTokens) {
      if (low.includes(token)) {
        symbolSignals.add(token);
      }
    }
  }

  const reasons: string[] = [];
  if (pathSignals.size >= 2) {
    reasons.push(
      "Repository appears workflow/plugin oriented based on top-level files.",
    );
  }
  if (symbolSignals.size >= 2) {
    reasons.push(
      "Repository symbols indicate skill/workflow orchestration patterns.",
    );
  }

  return {
    recommendation: reasons.length ? ("skill" as const) : ("general" as const),
    recommendationReasons: reasons,
    suggestedScope: topFiles.map((item) => item.path).slice(0, 8),
  };
};

const execFileAsync = (
  command: string,
  args: string[],
  cwd: string,
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        timeout: REPO_MAP_TIMEOUT_MS,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout?.toString() ?? "");
      },
    );
  });

const findRepoMapScript = (extensionPath: string) => {
  const candidates = [
    path.join(extensionPath, "tools", "repomap", "repomap.py"),
    path.join(process.cwd(), "tools", "repomap", "repomap.py"),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
};

const loadRepoMapHints = async (
  repoRootPath: string,
  extensionPath: string,
): Promise<RepoMapJson | undefined> => {
  const scriptPath = findRepoMapScript(extensionPath);
  if (!scriptPath) {
    return undefined;
  }
  try {
    const stdout = await execFileAsync(
      "python3",
      [
        scriptPath,
        "--repo-root",
        repoRootPath,
        "--max-tree-chars",
        "1200",
        "--max-symbols",
        "120",
        "--max-top-files",
        "20",
        "--max-hotspots",
        "12",
      ],
      repoRootPath,
    );
    const parsed = JSON.parse(stdout);
    return {
      top_files: Array.isArray(parsed?.top_files) ? parsed.top_files : [],
      symbols: Array.isArray(parsed?.symbols) ? parsed.symbols : [],
    };
  } catch {
    return undefined;
  }
};

const formatRepoHintsForPrompt = (context: RepoInterviewContext) => {
  const topFiles = (context.repoMap?.top_files ?? [])
    .slice(0, MAX_HINT_FILES)
    .map((item) => `${item.path} (${item.reason})`);
  const symbols = (context.repoMap?.symbols ?? [])
    .slice(0, MAX_HINT_SYMBOLS)
    .map((item) => `${item.path}: ${item.kind} ${item.name}`);
  return {
    topFiles,
    symbols,
  };
};

const generateSkillQuestions = async (
  core: Core,
  goal: string,
  workType: WorkType,
  context: RepoInterviewContext,
) => {
  const hints = formatRepoHintsForPrompt(context);
  const prompt =
    `You are designing a structured interview for an engineering plan.
Return ONLY valid JSON:
{
  "titleSuggestion": "...",
  "questions": [
    {"id":"intent","question":"..."},
    {"id":"scope","question":"..."},
    {"id":"approach","question":"..."},
    {"id":"nonGoals","question":"..."},
    {"id":"risks","question":"..."}
  ]
}

Constraints:
- Exactly one question per id above.
- Keep each question under 180 chars.
- Questions must be concrete and implementation-oriented.
- No markdown, no numbering.

Work type: ${workType}
Goal: ${goal}
Repo hint top files: ${hints.topFiles.join(" | ") || "(none)"}
Repo hint symbols: ${hints.symbols.join(" | ") || "(none)"}`.trim();

  const raw = await core.invoke("llm/complete", {
    prompt,
    completionOptions: {},
    title: "DevSherpa Skill Interview",
  });
  const json = extractJsonObject(raw);
  if (!json) {
    return coerceQuestions(null, DEFAULT_QUESTIONS);
  }
  try {
    return coerceQuestions(JSON.parse(json), DEFAULT_QUESTIONS);
  } catch {
    return coerceQuestions(null, DEFAULT_QUESTIONS);
  }
};

export const collectRepoInterviewContext = async (
  repoRootPath: string,
  extensionPath: string,
): Promise<RepoInterviewContext> => {
  const repoMap = await loadRepoMapHints(repoRootPath, extensionPath);
  const detected = detectRecommendation(repoMap);
  return {
    repoRootPath,
    recommendation: detected.recommendation,
    recommendationReasons: detected.recommendationReasons,
    suggestedScope: detected.suggestedScope,
    repoMap,
  };
};

export const runSkillPlanInterview = async (
  core: Core,
  context: RepoInterviewContext,
): Promise<SkillInterviewResult | null> => {
  const goal = await vscode.window.showInputBox({
    prompt: "What skill/workflow change do you want to plan?",
    placeHolder: "Short outcome-focused summary",
    ignoreFocusOut: true,
  });
  if (!goal) {
    return null;
  }

  const workTypePick = await vscode.window.showQuickPick(
    [
      {
        label: "New SaMD Capability",
        description: "New capability or workflow area",
        value: "new-samd" as WorkType,
      },
      {
        label: "Add Feature",
        description: "Add a capability to an existing surface",
        value: "add-feature" as WorkType,
      },
      {
        label: "Modify Feature",
        description: "Change behavior of existing feature",
        value: "modify-feature" as WorkType,
      },
    ],
    { placeHolder: "Select work type", ignoreFocusOut: true },
  );
  if (!workTypePick) {
    return null;
  }
  const workType = workTypePick.value;

  let questionsData = coerceQuestions(null, DEFAULT_QUESTIONS);
  try {
    questionsData = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Preparing skill interview…",
        cancellable: false,
      },
      () => generateSkillQuestions(core, goal, workType, context),
    );
  } catch {
    // Fall back to defaults if model call is unavailable.
  }

  const answers = {} as Record<PlanSectionId, string>;
  for (const question of questionsData.questions) {
    const scopeDefault =
      question.id === "scope" && context.suggestedScope.length
        ? context.suggestedScope.join(", ")
        : undefined;
    const answer = await vscode.window.showInputBox({
      prompt: question.question,
      placeHolder: "Short answer",
      value: scopeDefault,
      ignoreFocusOut: true,
    });
    if (answer === undefined) {
      return null;
    }
    answers[question.id] = answer.trim();
  }

  const title = await vscode.window.showInputBox({
    prompt: "Plan title",
    value: sanitizeTitle(questionsData.titleSuggestion ?? goal),
    ignoreFocusOut: true,
  });
  if (!title) {
    return null;
  }

  const content = buildPlanContent(title, answers, workType);
  const previewDoc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content,
  });
  await vscode.window.showTextDocument(previewDoc, { preview: true });

  const confirm = await vscode.window.showInformationMessage(
    "Create this plan and set it active?",
    "Create Plan",
    "Cancel",
  );
  if (confirm !== "Create Plan") {
    return null;
  }

  const hints = formatRepoHintsForPrompt(context);
  return {
    title,
    content,
    record: {
      schemaVersion: "1.0",
      createdAt: new Date().toISOString(),
      repoRootPath: context.repoRootPath,
      workType,
      goal: trimToLength(goal, 500),
      title: sanitizeTitle(title),
      recommendation: context.recommendation,
      recommendationReasons: context.recommendationReasons.slice(0, 4),
      answers: {
        intent: trimToLength(answers.intent ?? "", 600),
        scope: trimToLength(answers.scope ?? "", 600),
        approach: trimToLength(answers.approach ?? "", 600),
        nonGoals: trimToLength(answers.nonGoals ?? "", 600),
        risks: trimToLength(answers.risks ?? "", 600),
      },
      repoHints: {
        topFiles: hints.topFiles,
        symbols: hints.symbols,
      },
    },
  };
};
