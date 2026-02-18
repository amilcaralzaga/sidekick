import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

export const DEVSHERPA_DIR = ".devsherpa";
export const DEVSHERPA_PLANS_DIR = path.join(DEVSHERPA_DIR, "plans");
export const DEVSHERPA_SKILL_INTAKE_DIR = path.join(
  DEVSHERPA_DIR,
  "skill-intake",
);
const ACTIVE_PLAN_FILE = path.join(DEVSHERPA_DIR, "active-plan.json");

const MAX_TITLE_LENGTH = 120;

export interface ActivePlanPointer {
  path: string;
  updatedAt: string;
}

export interface PlanInfo {
  path: string; // workspace-relative
  title: string;
  scopeItems: string[];
}

const sanitizeTitle = (title: string) => {
  const trimmed = title.trim();
  if (trimmed.length <= MAX_TITLE_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_TITLE_LENGTH)}…`;
};

const slugify = (value: string) => {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "plan";
};

const extractPlanTitle = (content: string) => {
  const firstLine = content.split(/\r?\n/)[0] ?? "";
  const match = firstLine.match(/^#\s*Plan:\s*(.+)$/i);
  if (match?.[1]) {
    return sanitizeTitle(match[1]);
  }
  return "Untitled Plan";
};

const extractScopeItems = (content: string) => {
  const lines = content.split(/\r?\n/);
  const scopeIndex = lines.findIndex((line) =>
    line.trim().toLowerCase().startsWith("## scope"),
  );
  if (scopeIndex === -1) {
    return [];
  }
  const items: string[] = [];
  for (let i = scopeIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().startsWith("## ")) {
      break;
    }
    const bullet = line.trim().replace(/^[-*]\s+/, "");
    if (!bullet) {
      continue;
    }
    items.push(bullet);
  }
  return items;
};

const resolveRepoRoot = (repoRootPath: string) => {
  if (!repoRootPath) {
    return "";
  }
  return repoRootPath;
};

export const ensureDirs = (repoRootPath: string) => {
  const root = resolveRepoRoot(repoRootPath);
  if (!root) {
    return;
  }
  fs.mkdirSync(path.join(root, DEVSHERPA_PLANS_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, DEVSHERPA_SKILL_INTAKE_DIR), {
    recursive: true,
  });
};

export const listPlans = (repoRootPath: string): string[] => {
  try {
    const root = resolveRepoRoot(repoRootPath);
    if (!root) {
      return [];
    }
    const dir = path.join(root, DEVSHERPA_PLANS_DIR);
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".md"))
      .sort()
      .map((file) => path.join(DEVSHERPA_PLANS_DIR, file));
  } catch {
    return [];
  }
};

export const getActivePlanPath = (repoRootPath: string): string | null => {
  try {
    const root = resolveRepoRoot(repoRootPath);
    if (!root) {
      return null;
    }
    const pointerPath = path.join(root, ACTIVE_PLAN_FILE);
    if (!fs.existsSync(pointerPath)) {
      return null;
    }
    const raw = fs.readFileSync(pointerPath, "utf-8");
    const parsed = JSON.parse(raw) as ActivePlanPointer;
    if (!parsed?.path) {
      return null;
    }
    return parsed.path;
  } catch {
    return null;
  }
};

export const setActivePlanPath = (repoRootPath: string, relPath: string) => {
  const root = resolveRepoRoot(repoRootPath);
  if (!root) {
    return;
  }
  ensureDirs(root);
  const pointerPath = path.join(root, ACTIVE_PLAN_FILE);
  const payload: ActivePlanPointer = {
    path: relPath,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(pointerPath, JSON.stringify(payload, null, 2), "utf-8");
};

export const createPlan = (repoRootPath: string, title: string): string => {
  const root = resolveRepoRoot(repoRootPath);
  if (!root) {
    throw new Error("Missing repo root");
  }
  ensureDirs(root);
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(title);
  let filename = `${date}_${slug}.md`;
  let counter = 1;
  while (fs.existsSync(path.join(root, DEVSHERPA_PLANS_DIR, filename))) {
    counter += 1;
    filename = `${date}_${slug}-${counter}.md`;
  }
  const relPath = path.join(DEVSHERPA_PLANS_DIR, filename);
  const fullPath = path.join(root, relPath);
  const sanitizedTitle = sanitizeTitle(title);
  const template = `# Plan: ${sanitizedTitle}

## Intent
<one paragraph>

## Scope
- <paths or bullets>

## Approach
- <bullets>

## Non-goals
- <bullets>

## Risks
- <bullets>
`;
  fs.writeFileSync(fullPath, template, "utf-8");
  return relPath;
};

export const createSkillIntakeArtifact = (
  repoRootPath: string,
  title: string,
  payload: unknown,
): string => {
  const root = resolveRepoRoot(repoRootPath);
  if (!root) {
    throw new Error("Missing repo root");
  }
  ensureDirs(root);
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(title);
  let filename = `${date}_${slug}.json`;
  let counter = 1;
  while (fs.existsSync(path.join(root, DEVSHERPA_SKILL_INTAKE_DIR, filename))) {
    counter += 1;
    filename = `${date}_${slug}-${counter}.json`;
  }
  const relPath = path.join(DEVSHERPA_SKILL_INTAKE_DIR, filename);
  const fullPath = path.join(root, relPath);
  fs.writeFileSync(fullPath, JSON.stringify(payload, null, 2), "utf-8");
  return relPath;
};

export const readPlanInfo = (
  repoRootPath: string,
  relPath: string,
): PlanInfo | null => {
  try {
    const root = resolveRepoRoot(repoRootPath);
    if (!root) {
      return null;
    }
    const planPath = path.isAbsolute(relPath)
      ? relPath
      : path.join(root, relPath);
    if (!fs.existsSync(planPath)) {
      return null;
    }
    const content = fs.readFileSync(planPath, "utf-8");
    return {
      path: relPath,
      title: extractPlanTitle(content),
      scopeItems: extractScopeItems(content),
    };
  } catch {
    return null;
  }
};

export const getWorkspaceRootPath = (fileUri?: string): string | null => {
  if (fileUri) {
    const folder = vscode.workspace.getWorkspaceFolder(
      vscode.Uri.parse(fileUri),
    );
    if (folder?.uri?.fsPath) {
      return folder.uri.fsPath;
    }
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath ?? null;
};
