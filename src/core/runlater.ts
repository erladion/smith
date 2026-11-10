import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Files in a project that run code later, outside the sandbox, without you
 * deliberately running the project: when you enter the folder, open it in
 * an editor, commit, push (CI), install dependencies, build, or start its
 * containers. A change to one is how something in the sandbox could get out,
 * so the agent asks before changing one (even with "always allow") and says
 * when a turn changed one some other way.
 */
const RULES: { pattern: RegExp; why: string }[] = [
  { pattern: /(^|\/)\.envrc$/, why: "direnv runs it when you enter the folder" },
  { pattern: /(^|\/)(\.vscode\/|[^/]*\.code-workspace$)/, why: "VS Code reads it when you open the folder, and can run tasks from it" },
  { pattern: /(^|\/)\.idea\//, why: "JetBrains IDEs read it when you open the project" },
  { pattern: /(^|\/)(\.nvim\.lua|\.nvimrc|\.exrc|\.dir-locals\.el)$/, why: "your editor can run it when you open files here" },
  { pattern: /(^|\/)(\.husky|\.githooks)\//, why: "git hooks run when you commit" },
  { pattern: /(^|\/)(\.pre-commit-config\.ya?ml|\.?lefthook\.ya?ml|\.lintstagedrc[^/]*|lint-staged\.config\.[^/]+)$/, why: "it runs when you commit" },
  { pattern: /(^|\/)\.gitmodules$/, why: "git fetches what it points to" },
  { pattern: /(^|\/)(\.github\/workflows\/|\.gitlab-ci\.ya?ml$|Jenkinsfile$|\.circleci\/|azure-pipelines\.ya?ml$|\.travis\.ya?ml$|bitbucket-pipelines\.ya?ml$)/, why: "CI runs it when you push, often with secrets" },
  { pattern: /(^|\/)(package\.json|\.npmrc|\.yarnrc(\.ya?ml)?|\.pnpmfile\.c?js|bunfig\.toml)$/, why: "npm, yarn or pnpm run scripts from it when you install or build" },
  { pattern: /(^|\/)(setup\.py|setup\.cfg|pyproject\.toml|requirements[^/]*\.txt|Pipfile)$/, why: "pip runs or installs what it says when you install" },
  { pattern: /(^|\/)(Makefile|makefile|GNUmakefile|[^/]+\.mk|CMakeLists\.txt|[^/]+\.cmake|meson\.build|configure(\.ac)?)$/, why: "it runs when you build" },
  { pattern: /(^|\/)(build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle-wrapper\.properties|gradlew|mvnw|pom\.xml|build\.rs|Cargo\.toml)$|(^|\/)\.mvn\//, why: "it runs when you build" },
  { pattern: /(^|\/)(Dockerfile|Containerfile|[^/]+\.Dockerfile|(docker-)?compose[^/]*\.ya?ml)$|(^|\/)\.devcontainer\//, why: "it runs when you build or start containers, and can mount anything" },
];

/** Why a file (relative to the project, with / separators) runs outside the sandbox later, or undefined. */
export function runLaterReason(rel: string): string | undefined {
  return RULES.find((r) => r.pattern.test(rel))?.why;
}

// Folders never worth looking in.
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "venv", "__pycache__", "target"]);
const MAX_FILES = 50_000;
const MAX_HASHED = 2_000;

/** A fingerprint of every such file in the project: relative path → content hash. */
export function snapshotRunLater(cwd: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const rel of projectFiles(cwd)) {
    if (!runLaterReason(rel)) continue;
    const hash = hashFile(path.join(cwd, rel));
    if (hash) snapshot.set(rel, hash);
    if (snapshot.size >= MAX_HASHED) break;
  }
  return snapshot;
}

export function hashFile(file: string): string | undefined {
  try {
    return createHash("sha1").update(fs.readFileSync(file)).digest("hex");
  } catch {
    return undefined;
  }
}

export function hashText(text: string): string {
  return createHash("sha1").update(text).digest("hex");
}

export interface RunLaterChange {
  rel: string;
  kind: "changed" | "created" | "deleted";
  why: string;
}

/** What changed between two snapshots. */
export function runLaterChanges(before: Map<string, string>, after: Map<string, string>): RunLaterChange[] {
  const changes: RunLaterChange[] = [];
  for (const [rel, hash] of after) {
    const old = before.get(rel);
    if (old !== hash) changes.push({ rel, kind: old === undefined ? "created" : "changed", why: runLaterReason(rel)! });
  }
  for (const rel of before.keys()) if (!after.has(rel)) changes.push({ rel, kind: "deleted", why: runLaterReason(rel)! });
  return changes.sort((a, b) => a.rel.localeCompare(b.rel));
}

/**
 * The project's files, relative: what git knows of (tracked and untracked,
 * not ignored) in a repository, else a walk that skips the usual folders.
 */
function projectFiles(cwd: string): string[] {
  // fsmonitor off: git must not run anything from the repository's config here.
  const git = spawnSync("git", ["-c", "core.fsmonitor=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 10_000,
  });
  if (git.status === 0) return git.stdout.split("\0").filter(Boolean).slice(0, MAX_FILES);

  const files: string[] = [];
  const stack = [""];
  while (stack.length && files.length < MAX_FILES) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(cwd, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(rel);
      } else files.push(rel);
    }
  }
  return files;
}
