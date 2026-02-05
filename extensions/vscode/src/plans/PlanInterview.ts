import * as vscode from "vscode";

import { Core } from "core/core";

type PlanSectionId = "intent" | "scope" | "approach" | "nonGoals" | "risks";

interface InterviewQuestion {
  id: PlanSectionId;
  question: string;
}

export interface PlanInterviewResult {
  title: string;
  content: string;
}

const REQUIRED_SECTION_ORDER: PlanSectionId[] = [
  "intent",
  "scope",
  "approach",
  "nonGoals",
  "risks",
];

const DEFAULT_QUESTIONS: InterviewQuestion[] = [
  {
    id: "intent",
    question: "What is the intent of this work? (1-2 sentences)",
  },
  {
    id: "scope",
    question:
      "What’s in scope? List key files, folders, or behaviors (comma or line separated).",
  },
  {
    id: "approach",
    question: "What approach will you take? (short bullets or sentences)",
  },
  {
    id: "nonGoals",
    question: "What is explicitly out of scope?",
  },
  {
    id: "risks",
    question: "What risks or tradeoffs should reviewers watch for?",
  },
];

const MAX_TITLE_LENGTH = 120;
const MAX_SECTION_CHARS = 600;
const MAX_BULLETS = 8;
const MAX_BULLET_CHARS = 160;

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

const trimToLength = (value: string, max: number) => {
  const trimmed = value.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  return `${trimmed.slice(0, max)}…`;
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
  const suggestion =
    typeof payload?.titleSuggestion === "string"
      ? payload.titleSuggestion
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
        if (REQUIRED_SECTION_ORDER.includes(id)) {
          questions.set(id, trimToLength(entry.question, 160));
        }
      }
    }
  }
  const normalized = REQUIRED_SECTION_ORDER.map((id) => {
    const question =
      questions.get(id) || fallback.find((item) => item.id === id)?.question;
    return { id, question: question ?? "Provide details." };
  });
  return { titleSuggestion: suggestion, questions: normalized };
};

const buildPlanContent = (
  title: string,
  answers: Record<PlanSectionId, string>,
) => {
  const sanitizedTitle = sanitizeTitle(title);
  return `# Plan: ${sanitizedTitle}

## Intent
${formatParagraph(answers.intent)}

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

const generateInterviewQuestions = async (core: Core, goal: string) => {
  const prompt =
    `You are a product planning interviewer. Given the user's goal, output JSON with a short title suggestion and exactly one question per plan section.

Return ONLY valid JSON matching:
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
- Keep each question under 160 characters.
- Use plain text, no numbering, no bullets.
- Questions should help a developer create a short plan.

User goal:
${goal}`.trim();

  const raw = await core.invoke("llm/complete", {
    prompt,
    completionOptions: {},
    title: "DevSherpa Plan Interview",
  });

  const json = extractJsonObject(raw);
  if (!json) {
    return coerceQuestions(null, DEFAULT_QUESTIONS);
  }
  try {
    const parsed = JSON.parse(json);
    return coerceQuestions(parsed, DEFAULT_QUESTIONS);
  } catch {
    return coerceQuestions(null, DEFAULT_QUESTIONS);
  }
};

export const runPlanInterview = async (
  core: Core,
): Promise<PlanInterviewResult | null> => {
  const goal = await vscode.window.showInputBox({
    prompt: "What do you want to plan?",
    placeHolder: "Short summary of the change or project",
    ignoreFocusOut: true,
  });
  if (!goal) {
    return null;
  }

  let questionsData = coerceQuestions(null, DEFAULT_QUESTIONS);
  try {
    questionsData = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Preparing plan interview…",
        cancellable: false,
      },
      () => generateInterviewQuestions(core, goal),
    );
  } catch {
    // Fall back to defaults if the model isn't available.
  }

  const answers = {} as Record<PlanSectionId, string>;
  for (const question of questionsData.questions) {
    const answer = await vscode.window.showInputBox({
      prompt: question.question,
      placeHolder: "Short answer",
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

  const content = buildPlanContent(title, answers);

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

  return { title, content };
};
