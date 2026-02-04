import * as fs from "fs";
import * as path from "path";

import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
} from "../../index.js";
import { localPathOrUriToPath } from "../../util/pathToUri.js";
import { BaseContextProvider } from "../index.js";

const ACTIVE_PLAN_POINTER = path.join(".sidekick", "active-plan.json");
const MAX_SECTION_CHARS = 600;
const MAX_TOTAL_CHARS = 3000;
const MAX_LINES = 200;

const SECTION_ORDER = [
  "Intent",
  "Scope",
  "Approach",
  "Non-goals",
  "Risks",
] as const;

type SectionName = (typeof SECTION_ORDER)[number];

const trimTo = (value: string, limit: number) => {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}…`;
};

const readActivePlanPointer = (repoRootPath: string): string | null => {
  try {
    const pointerPath = path.join(repoRootPath, ACTIVE_PLAN_POINTER);
    if (!fs.existsSync(pointerPath)) {
      return null;
    }
    const raw = fs.readFileSync(pointerPath, "utf-8");
    const parsed = JSON.parse(raw) as { path?: string };
    if (!parsed?.path) {
      return null;
    }
    return parsed.path;
  } catch {
    return null;
  }
};

const readPlanContent = (
  repoRootPath: string,
  relPath: string,
): string | null => {
  try {
    const fullPath = path.isAbsolute(relPath)
      ? relPath
      : path.join(repoRootPath, relPath);
    if (!fs.existsSync(fullPath)) {
      return null;
    }
    return fs.readFileSync(fullPath, "utf-8");
  } catch {
    return null;
  }
};

const extractTitle = (lines: string[]) => {
  const first = lines[0] ?? "";
  const match = first.match(/^#\s*Plan:\s*(.+)$/i);
  if (match?.[1]) {
    return trimTo(match[1], 120);
  }
  return "Untitled Plan";
};

const extractSections = (lines: string[]) => {
  const sections: Record<SectionName, string[]> = {
    Intent: [],
    Scope: [],
    Approach: [],
    "Non-goals": [],
    Risks: [],
  };

  let current: SectionName | null = null;
  for (const line of lines) {
    const heading = line.match(/^##\s+(.+)\s*$/);
    if (heading) {
      const name = heading[1].trim();
      if (SECTION_ORDER.includes(name as SectionName)) {
        current = name as SectionName;
      } else {
        current = null;
      }
      continue;
    }
    if (!current) {
      continue;
    }
    sections[current].push(line);
  }
  return sections;
};

const formatPlanContent = (content: string): string => {
  const lines = content.split(/\r?\n/);
  const title = extractTitle(lines);
  const sections = extractSections(lines);

  const output: string[] = [];
  output.push(`Active Plan: ${title}`);

  for (const section of SECTION_ORDER) {
    output.push("");
    output.push(`${section}:`);
    const raw = sections[section].join("\n");
    const trimmed = trimTo(raw, MAX_SECTION_CHARS);
    output.push(trimmed ? trimmed : "(empty)");
  }

  let joined = output.join("\n");
  if (joined.length > MAX_TOTAL_CHARS) {
    joined = `${joined.slice(0, MAX_TOTAL_CHARS)}…`;
  }

  const limitedLines = joined.split(/\r?\n/).slice(0, MAX_LINES);
  return limitedLines.join("\n");
};

const getWorkspaceRootPath = async (
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
    // ignore
  }

  const repoRootPath = localPathOrUriToPath(repoRootUri);
  return repoRootPath || null;
};

class PlanContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "active-plan",
    displayTitle: "Active Plan",
    description: "Inject the active plan (bounded, read-only)",
    type: "normal",
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    const repoRootPath = await getWorkspaceRootPath(extras);
    if (!repoRootPath) {
      return [];
    }

    const relPath = readActivePlanPointer(repoRootPath);
    if (!relPath) {
      return [];
    }

    const content = readPlanContent(repoRootPath, relPath);
    if (!content) {
      return [];
    }

    const formatted = formatPlanContent(content);
    if (!formatted.trim()) {
      return [];
    }

    return [
      {
        name: "Active Plan",
        description: "Active plan (read-only, bounded)",
        content: formatted,
      },
    ];
  }
}

export default PlanContextProvider;
