import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as fs from "fs";
import * as path from "path";

import {
  ContextItem,
  ContextProviderDescription,
  ContextProviderExtras,
} from "../../index.js";
import { getContinueGlobalPath } from "../../util/paths.js";
import { localPathOrUriToPath } from "../../util/pathToUri.js";
import { findUriInDirs } from "../../util/uri.js";
import { BaseContextProvider } from "../index.js";

const DEFAULT_MAX_TREE_CHARS = 4000;
const DEFAULT_MAX_SYMBOLS = 200;
const DEFAULT_MAX_TOP_FILES = 50;
const DEFAULT_MAX_HOTSPOTS = 20;
const DEFAULT_MAX_TREE_DEPTH = 4;
const DEFAULT_MAX_FILE_KB = 512;
const DEFAULT_MAX_SCAN_LINES = 4000;
const DEFAULT_MAX_FILES = 5000;
const DEFAULT_MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const DEFAULT_CACHE_TTL_SECONDS = 600;
const DEFAULT_DIRTY_TTL_SECONDS = 120;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_ERROR_TRIM = 1200;

const MODULE_DIR =
  typeof __dirname === "undefined"
    ? path.dirname(fileURLToPath(import.meta.url))
    : __dirname;

const SCRIPT_RELATIVE_PATH = path.join("tools", "repomap", "repomap.py");

interface RepoMapOptions {
  maxTreeChars?: number;
  maxSymbols?: number;
  maxTopFiles?: number;
  maxHotspots?: number;
  maxTreeDepth?: number;
  maxFileKb?: number;
  maxFileBytes?: number;
  maxScanLines?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  cacheTtlSeconds?: number;
  dirtyCacheTtlSeconds?: number;
  include?: string[] | string;
  exclude?: string[] | string;
  pythonPath?: string;
}

interface RepoMapJson {
  repo_root: string;
  generated_at: string;
  git_head: string;
  tree: string;
  top_files: Array<{ path: string; reason: string }>;
  symbols: Array<{ name: string; kind: string; path: string; line: number }>;
  hotspots: Array<{ path: string; signals: string[] }>;
  notes: string[];
}

const toNumber = (value: unknown, fallback: number): number => {
  const parsed = typeof value === "string" ? Number(value) : (value as number);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return parsed;
};

const clampMax = (value: number, max: number): number => {
  if (!Number.isFinite(value)) {
    return max;
  }
  return Math.min(value, max);
};

const toStringArray = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string");
  }
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  return [];
};

const hashKey = (value: string): string => {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 24);
};

const trimErrorText = (
  value: string | undefined,
  limit = DEFAULT_ERROR_TRIM,
) => {
  if (!value) {
    return "";
  }
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}…`;
};

const formatFailureContent = (reason: string, error?: Error) => {
  const stderr = trimErrorText((error as any)?.stderr);
  const message = trimErrorText(error?.message);
  const lines: string[] = [`RepoMap unavailable: ${reason}`];
  if (message) {
    lines.push(`Error: ${message}`);
  }
  if (stderr) {
    lines.push("Stderr:");
    lines.push(stderr);
  }
  lines.push(
    "Remediation: install Python 3 or set `pythonPath` in your repo-map context provider params.",
  );
  return lines.join("\n");
};

const execFileAsync = (
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; maxBuffer?: number },
): Promise<{ stdout: string; stderr: string }> => {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const err = new Error(
            `Repomap failed (${command}): ${String(error.message || error)}`,
          ) as Error & {
            stdout?: string;
            stderr?: string;
            code?: string | number;
            errno?: number;
          };
          err.stdout = stdout?.toString();
          err.stderr = stderr?.toString();
          err.code = (error as unknown as { code?: string | number }).code;
          err.errno = (error as unknown as { errno?: number }).errno;
          reject(err);
          return;
        }
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
        });
      },
    );
  });
};

const findRepomapScript = (repoRootPath: string): string | null => {
  const candidates = [
    path.join(repoRootPath, SCRIPT_RELATIVE_PATH),
    path.resolve(process.cwd(), SCRIPT_RELATIVE_PATH),
    path.resolve(MODULE_DIR, "../../..", SCRIPT_RELATIVE_PATH),
    path.resolve(MODULE_DIR, "../../../..", SCRIPT_RELATIVE_PATH),
    path.resolve(MODULE_DIR, "../../../../..", SCRIPT_RELATIVE_PATH),
  ];

  const uniqueCandidates = Array.from(new Set(candidates));
  for (const candidate of uniqueCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const getWorkspaceRootUri = async (
  extras: ContextProviderExtras,
): Promise<string | undefined> => {
  const workspaceDirs = await extras.ide.getWorkspaceDirs();
  if (!workspaceDirs.length) {
    return undefined;
  }

  let workspaceDir = workspaceDirs[0];
  try {
    const currentFile = await extras.ide.getCurrentFile();
    if (currentFile?.path) {
      const { foundInDir } = findUriInDirs(currentFile.path, workspaceDirs);
      if (foundInDir) {
        workspaceDir = foundInDir;
      }
    }
  } catch {
    // ignore and fall back to first workspace dir
  }

  return workspaceDir;
};

const getCacheDir = (repoRootPath: string): string => {
  const workspaceCacheDir = path.join(repoRootPath, ".continue", "cache");
  try {
    fs.mkdirSync(workspaceCacheDir, { recursive: true });
    return workspaceCacheDir;
  } catch {
    const globalCacheDir = path.join(getContinueGlobalPath(), "cache");
    fs.mkdirSync(globalCacheDir, { recursive: true });
    return globalCacheDir;
  }
};

const readCache = (
  cachePath: string,
  maxAgeMs?: number,
): RepoMapJson | null => {
  try {
    const stats = fs.statSync(cachePath);
    if (maxAgeMs && Date.now() - stats.mtimeMs > maxAgeMs) {
      return null;
    }
    const raw = fs.readFileSync(cachePath, "utf-8");
    return JSON.parse(raw) as RepoMapJson;
  } catch {
    return null;
  }
};

const writeCache = (cachePath: string, data: RepoMapJson): void => {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    fs.writeFileSync(cachePath, JSON.stringify(data));
  } catch {
    // ignore cache write errors
  }
};

const formatRepoMap = (data: RepoMapJson): string => {
  const lines: string[] = [];
  lines.push("Repository map:");
  lines.push(`Repo root: ${data.repo_root}`);
  if (data.git_head) {
    lines.push(`Git head: ${data.git_head}`);
  }
  if (data.generated_at) {
    lines.push(`Generated at: ${data.generated_at}`);
  }
  lines.push("");
  lines.push("Tree:");
  lines.push(data.tree?.trim() ? data.tree : "(empty)");

  if (data.top_files?.length) {
    lines.push("");
    lines.push("Top files:");
    for (const file of data.top_files) {
      lines.push(`- ${file.path} — ${file.reason}`);
    }
  }

  if (data.symbols?.length) {
    lines.push("");
    lines.push("Symbols:");
    for (const symbol of data.symbols) {
      lines.push(
        `- ${symbol.path}: ${symbol.kind} ${symbol.name} (line ${symbol.line})`,
      );
    }
  }

  if (data.hotspots?.length) {
    lines.push("");
    lines.push("Hotspots:");
    for (const hotspot of data.hotspots) {
      const signals = hotspot.signals?.length ? hotspot.signals.join(", ") : "";
      lines.push(`- ${hotspot.path}${signals ? ` [${signals}]` : ""}`);
    }
  }

  if (data.notes?.length) {
    lines.push("");
    lines.push("Notes:");
    for (const note of data.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join("\n");
};

class RepoMapContextProvider extends BaseContextProvider {
  static description: ContextProviderDescription = {
    title: "repo-map",
    displayTitle: "Repo Map",
    description: "Compact, deterministic repository overview",
    type: "normal",
  };

  async getContextItems(
    query: string,
    extras: ContextProviderExtras,
  ): Promise<ContextItem[]> {
    const workspaceRootUri = await getWorkspaceRootUri(extras);
    if (!workspaceRootUri) {
      return [];
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

    const repoRootPath = localPathOrUriToPath(repoRootUri);

    const options = this.options as RepoMapOptions;
    const maxTreeChars = clampMax(
      toNumber(options?.maxTreeChars, DEFAULT_MAX_TREE_CHARS),
      DEFAULT_MAX_TREE_CHARS,
    );
    const maxSymbols = clampMax(
      toNumber(options?.maxSymbols, DEFAULT_MAX_SYMBOLS),
      DEFAULT_MAX_SYMBOLS,
    );
    const maxTopFiles = clampMax(
      toNumber(options?.maxTopFiles, DEFAULT_MAX_TOP_FILES),
      DEFAULT_MAX_TOP_FILES,
    );
    const maxHotspots = clampMax(
      toNumber(options?.maxHotspots, DEFAULT_MAX_HOTSPOTS),
      DEFAULT_MAX_HOTSPOTS,
    );
    const maxTreeDepth = clampMax(
      toNumber(options?.maxTreeDepth, DEFAULT_MAX_TREE_DEPTH),
      DEFAULT_MAX_TREE_DEPTH,
    );
    const maxFileKb = clampMax(
      toNumber(options?.maxFileKb, DEFAULT_MAX_FILE_KB),
      DEFAULT_MAX_FILE_KB,
    );
    const maxFileBytes = clampMax(
      toNumber(options?.maxFileBytes, maxFileKb * 1024),
      maxFileKb * 1024,
    );
    const maxScanLines = toNumber(
      options?.maxScanLines,
      DEFAULT_MAX_SCAN_LINES,
    );
    const maxFiles = clampMax(
      toNumber(options?.maxFiles, DEFAULT_MAX_FILES),
      DEFAULT_MAX_FILES,
    );
    const maxTotalBytes = clampMax(
      toNumber(options?.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES),
      DEFAULT_MAX_TOTAL_BYTES,
    );
    const cacheTtlSeconds = toNumber(
      options?.cacheTtlSeconds,
      DEFAULT_CACHE_TTL_SECONDS,
    );
    const dirtyCacheTtlSeconds = toNumber(
      options?.dirtyCacheTtlSeconds,
      DEFAULT_DIRTY_TTL_SECONDS,
    );

    let gitHead = "";
    try {
      const [stdout] = await extras.ide.subprocess(
        "git rev-parse HEAD",
        repoRootPath,
      );
      gitHead = stdout.trim();
    } catch {
      gitHead = "";
    }

    let isDirty = false;
    try {
      const [stdout] = await extras.ide.subprocess(
        "git status --porcelain",
        repoRootPath,
      );
      isDirty = stdout.trim().length > 0;
    } catch {
      isDirty = false;
    }

    const cacheDir = getCacheDir(repoRootPath);
    const cacheKey = hashKey(`${repoRootPath}|${gitHead || "nogit"}`);
    const cachePath = path.join(cacheDir, `repomap_${cacheKey}.json`);

    let cacheMaxAge = gitHead ? undefined : cacheTtlSeconds * 1000;
    if (isDirty) {
      const ttlSeconds = Math.min(cacheTtlSeconds, dirtyCacheTtlSeconds);
      cacheMaxAge = ttlSeconds * 1000;
    }
    const cached = readCache(cachePath, cacheMaxAge);
    if (cached) {
      return [
        {
          name: "RepoMap",
          description: "Repo map",
          content: formatRepoMap(cached),
        },
      ];
    }

    const scriptPath = findRepomapScript(repoRootPath);
    if (!scriptPath) {
      return [
        {
          name: "RepoMap",
          description: "Repo map (unavailable)",
          content: formatFailureContent("repomap.py not found"),
        },
      ];
    }

    const includeGlobs = toStringArray(options?.include);
    const excludeGlobs = toStringArray(options?.exclude);

    const args = [
      scriptPath,
      "--repo-root",
      repoRootPath,
      "--max-tree-chars",
      String(maxTreeChars),
      "--max-symbols",
      String(maxSymbols),
      "--max-top-files",
      String(maxTopFiles),
      "--max-hotspots",
      String(maxHotspots),
      "--max-tree-depth",
      String(maxTreeDepth),
      "--max-file-kb",
      String(maxFileKb),
      "--max-file-bytes",
      String(maxFileBytes),
      "--max-scan-lines",
      String(maxScanLines),
      "--max-files",
      String(maxFiles),
      "--max-total-bytes",
      String(maxTotalBytes),
    ];

    for (const pattern of includeGlobs) {
      args.push("--include", pattern);
    }
    for (const pattern of excludeGlobs) {
      args.push("--exclude", pattern);
    }

    const pythonCandidates = [options?.pythonPath, "python3", "python"].filter(
      (value): value is string => typeof value === "string",
    );

    let lastError: Error | undefined;
    for (const pythonCmd of pythonCandidates) {
      try {
        const { stdout } = await execFileAsync(pythonCmd, args, {
          cwd: repoRootPath,
          timeout: DEFAULT_TIMEOUT_MS,
          maxBuffer: DEFAULT_MAX_BUFFER,
        });
        const trimmed = stdout.trim();
        if (!trimmed) {
          throw new Error("RepoMap sidecar returned no output.");
        }
        const parsed = JSON.parse(trimmed) as RepoMapJson;
        writeCache(cachePath, parsed);
        return [
          {
            name: "RepoMap",
            description: "Repo map",
            content: formatRepoMap(parsed),
          },
        ];
      } catch (err) {
        lastError = err as Error;
      }
    }

    const missingPython =
      (lastError as any)?.code === "ENOENT" || (lastError as any)?.errno === -2;
    const reason = missingPython ? "python3 not found" : "repomap.py failed";

    return [
      {
        name: "RepoMap",
        description: "Repo map (failed)",
        content: formatFailureContent(reason, lastError),
      },
    ];
  }
}

export default RepoMapContextProvider;
