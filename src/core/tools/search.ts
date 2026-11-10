import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { globToRegExp } from "../glob.js";
import { resolveForRead } from "../paths.js";
import { Sandbox, type SpawnSpec } from "../sandbox.js";
import { fastTools } from "../toolchain.js";
import { defineTool, type ToolContext, type ToolResult, truncate } from "../tool.js";
import { OUTSIDE } from "./files.js";

/**
 * Where a search of `target` runs. In a container the project is the same
 * folder inside and out, so it's searched here, where ripgrep is; anything
 * else is the container's own and is searched inside it.
 */
function searchSandbox(ctx: ToolContext, target: string): Sandbox {
  const sandbox = ctx.sandbox ?? Sandbox.none();
  if (sandbox.type === "container" && !sandbox.sandboxPath(target, ctx.cwd)) return Sandbox.none();
  return sandbox;
}

/** Approval reason for searching a path outside the project. */
async function outsideReason(p: string | undefined, ctx: ToolContext): Promise<string | undefined> {
  return p && (await resolveForRead(ctx.cwd, p, ctx.sandbox)).outside ? OUTSIDE : undefined;
}

const MAX_OUTPUT_CHARS = 15_000;
const MAX_GLOB_RESULTS = 200;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__"]);

const grepSchema = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for"),
  path: z.string().optional().describe("File or directory to search (default: the working directory); may be outside it, which asks the user"),
  glob: z.string().optional().describe('Only search files matching this glob, e.g. "*.ts" or "src/**/*.py"'),
  ignore_case: z.boolean().optional().describe("Case-insensitive search"),
  context: z.number().int().min(0).max(10).optional().describe("Lines of context around each match"),
  files_only: z.boolean().optional().describe("Return only the paths of matching files"),
});
type GrepInput = z.output<typeof grepSchema>;

export const grep = defineTool({
  name: "grep",
  description:
    "Search file contents with a regular expression (ripgrep syntax). Respects .gitignore. " +
    "Returns matching lines as path:line:text, or only file paths with files_only. " +
    "Prefer this over running grep through bash.",
  schema: grepSchema,
  readOnly: true,
  summarize: ({ pattern, path: p, glob }) =>
    [`/${pattern}/`, p && `in ${p}`, glob && `(${glob})`].filter(Boolean).join(" "),
  approvalReason: ({ path: p }, ctx) => outsideReason(p, ctx),
  async run(input, ctx) {
    const absolute = input.path ? (await resolveForRead(ctx.cwd, input.path, ctx.sandbox)).path : ctx.cwd;
    const target = path.relative(ctx.cwd, absolute) || ".";
    const sandbox = searchSandbox(ctx, absolute);
    // ripgrep when installed (much faster, respects .gitignore), else grep. In a
    // container, this machine's ripgrep isn't there; grep is.
    const rg = sandbox.type === "container" ? undefined : fastTools().rg;
    const search = async (cmd: string, args: string[]) => {
      try {
        return await runSearch(await sandbox.programSpec(cmd, args, ctx.cwd), ctx.cwd, ctx.signal);
      } catch (err) {
        return { output: (err as Error).message, code: 2, missing: false };
      }
    };
    let result = rg ? await search(rg, ripgrepArgs(input, target)) : undefined;
    if (!result || result.missing) result = await search("grep", grepArgs(input, target));

    if (result.missing) return { content: "Neither rg nor grep is installed.", isError: true };
    // Both tools exit 1 for "no matches" and 2 for real errors.
    if (result.code === 1 && !result.output.trim()) return { content: "No matches." };
    if (result.code !== 0 && result.code !== 1) {
      return { content: result.output.trim() || `Search failed with exit code ${result.code}`, isError: true };
    }
    return { content: truncate(result.output.trimEnd(), MAX_OUTPUT_CHARS) };
  },
});

export const glob = defineTool({
  name: "glob",
  description:
    'Find files by name with a glob pattern such as "**/*.ts" or "src/**/test_*.py". ' +
    `Returns up to ${MAX_GLOB_RESULTS} paths, most recently modified first. ` +
    "Skips .git, node_modules, common build directories and (when ripgrep is installed) anything in .gitignore.",
  schema: z.object({
    pattern: z.string().min(1).describe("Glob pattern, relative to path"),
    path: z.string().optional().describe("Directory to search from (default: the working directory); may be outside it, which asks the user"),
  }),
  readOnly: true,
  summarize: ({ pattern, path: p }) => (p ? `${pattern} in ${p}` : pattern),
  approvalReason: ({ path: p }, ctx) => outsideReason(p, ctx),
  async run({ pattern, path: p }, ctx): Promise<ToolResult> {
    if (path.isAbsolute(pattern) || pattern.split("/").includes("..")) {
      return { content: "The pattern must be relative and must not contain '..'. Use path to choose where to search.", isError: true };
    }
    const base = (await resolveForRead(ctx.cwd, p ?? ".", ctx.sandbox)).path;
    const sandbox = searchSandbox(ctx, base);
    const regex = globToRegExp(pattern);
    const matches: { file: string; mtime: number }[] = [];

    let files: AsyncGenerator<{ rel: string; abs: string }>;
    try {
      files = await allFiles(ctx, sandbox, base);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
    for await (const { rel, abs } of files) {
      if (!regex.test(rel)) continue;
      // The sandbox's /tmp is somewhere else on this machine, and a container's
      // own files are nowhere here: those are listed as files, oldest first.
      const view = sandbox.sandboxPath(abs, ctx.cwd);
      const stat = view && !view.host ? { isFile: () => true, mtimeMs: 0 } : await fs.stat(view?.host ?? abs).catch(() => null);
      if (!stat?.isFile()) continue;
      matches.push({ file: path.relative(ctx.cwd, abs), mtime: stat.mtimeMs });
      // Collect a few more than we show so the newest files are likely among them.
      if (matches.length >= MAX_GLOB_RESULTS * 5) break;
    }

    if (matches.length === 0) return { content: "No files matched." };
    matches.sort((a, b) => b.mtime - a.mtime);
    const shown = matches.slice(0, MAX_GLOB_RESULTS).map((m) => m.file);
    const more = matches.length > shown.length ? `\n\n[${matches.length - shown.length}+ more not shown; narrow the pattern]` : "";
    return { content: shown.join("\n") + more };
  },
});

const MAX_LIST_DEPTH = 6;
const MAX_LIST_LINES = 300;
const MAX_FILES_PER_FOLDER = 40;

export const list = defineTool({
  name: "list_files",
  description:
    "Show what's in a folder as a tree: folders first, then files, a couple of levels deep. Deeper folders " +
    "are collapsed to a file count. Use it to get the layout of a project or a folder; use glob to find files " +
    "by name. Skips .git, node_modules, common build directories and (when ripgrep is installed) anything in " +
    ".gitignore.",
  schema: z.object({
    path: z.string().optional().describe("The folder (default: the working directory); may be outside it, which asks the user"),
    depth: z.number().int().min(1).max(MAX_LIST_DEPTH).optional().describe("Levels of folders to open (default 2)"),
  }),
  readOnly: true,
  summarize: ({ path: p, depth }) => `${p ?? "."}${depth ? ` (depth ${depth})` : ""}`,
  approvalReason: ({ path: p }, ctx) => outsideReason(p, ctx),
  async run({ path: p, depth = 2 }, ctx): Promise<ToolResult> {
    const base = (await resolveForRead(ctx.cwd, p ?? ".", ctx.sandbox)).path;
    const sandbox = searchSandbox(ctx, base);
    const shown = p ?? ".";
    // Check it's a folder, where it's on this machine at all (not a container's own).
    const view = sandbox.sandboxPath(base, ctx.cwd);
    if (!view || view.host) {
      const stat = await fs.stat(view?.host ?? base).catch(() => null);
      if (!stat) return { content: `${shown} doesn't exist.`, isError: true };
      if (!stat.isDirectory()) return { content: `${shown} is a file; read it with read_file.`, isError: true };
    }

    const root = newFolder();
    let total = 0;
    try {
      for await (const { rel } of await allFiles(ctx, sandbox, base)) {
        total++;
        const parts = rel.split("/");
        let folder = root;
        folder.count++;
        for (const name of parts.slice(0, -1)) {
          let next = folder.folders.get(name);
          if (!next) folder.folders.set(name, (next = newFolder()));
          next.count++;
          folder = next;
        }
        folder.files.push(parts.at(-1)!);
      }
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
    if (total === 0) return { content: `${shown} is empty (or holds only skipped folders).` };

    const lines: string[] = [`${shown.replace(/\/+$/, "")}/ (${fileCount(total)})`];
    let cut = false;
    const add = (line: string) => {
      if (lines.length > MAX_LIST_LINES) return (cut = true), false;
      lines.push(line);
      return true;
    };
    const render = (folder: Folder, level: number, indent: string): void => {
      for (const [name, sub] of [...folder.folders].sort(([a], [b]) => a.localeCompare(b))) {
        if (level >= depth) {
          if (!add(`${indent}${name}/ (${fileCount(sub.count)})`)) return;
        } else {
          if (!add(`${indent}${name}/`)) return;
          render(sub, level + 1, `${indent}  `);
          if (cut) return;
        }
      }
      const names = folder.files.sort((a, b) => a.localeCompare(b));
      for (const name of names.slice(0, MAX_FILES_PER_FOLDER)) if (!add(`${indent}${name}`)) return;
      if (names.length > MAX_FILES_PER_FOLDER) add(`${indent}… ${names.length - MAX_FILES_PER_FOLDER} more file${names.length - MAX_FILES_PER_FOLDER === 1 ? "" : "s"}`);
    };
    render(root, 1, "  ");
    if (cut) lines.push(`\n[Stopped at ${MAX_LIST_LINES} lines; list a subfolder, or use a smaller depth]`);
    return { content: lines.join("\n") };
  },
});

interface Folder {
  folders: Map<string, Folder>;
  files: string[];
  /** Files in it and everything below. */
  count: number;
}

const newFolder = (): Folder => ({ folders: new Map(), files: [], count: 0 });
const fileCount = (n: number) => `${n} file${n === 1 ? "" : "s"}`;

/**
 * Every file under `base`, as glob and list_files see them: listed inside
 * the sandbox when it's active, so hidden folders stay hidden; with ripgrep
 * when it's there (and not in a container), which also skips .gitignored files.
 */
async function allFiles(ctx: ToolContext, sandbox: Sandbox, base: string): Promise<AsyncGenerator<{ rel: string; abs: string }>> {
  const rg = sandbox.type === "container" ? undefined : fastTools().rg;
  if (rg) return listFiles(await sandbox.programSpec(rg, ripgrepListArgs(), ctx.cwd, { chdir: base }), base, ctx.signal);
  if (sandbox.active) return listFiles(await sandbox.programSpec("find", findArgs(), ctx.cwd, { chdir: base }), base, ctx.signal);
  return walk(base, ctx.signal);
}

const MAX_WALK_ENTRIES = 100_000;

/**
 * Yields every file and directory under `base` as a slash-separated relative
 * path. Doesn't follow symlinked directories, so it can't leave `base`.
 */
async function* walk(base: string, signal: AbortSignal): AsyncGenerator<{ rel: string; abs: string }> {
  const stack = [""];
  let seen = 0;
  while (stack.length > 0) {
    const relDir = stack.pop()!;
    const entries = await fs.readdir(path.join(base, relDir), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (signal.aborted || ++seen > MAX_WALK_ENTRIES) return;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(rel);
        continue;
      }
      yield { rel, abs: path.join(base, rel) };
    }
  }
}

const MAX_LISTING_CHARS = 32_000_000;

/**
 * `rg --files`: much faster than walking the tree in JavaScript on big
 * repositories, and it skips what .gitignore ignores. Hidden files are
 * included, as in the built-in walker.
 */
function ripgrepListArgs(): string[] {
  const args = ["--files", "--hidden", "--color", "never"];
  for (const dir of SKIP_DIRS) args.push("--glob", `!${dir}`);
  return args;
}

/** `find` listing what the built-in walker would: everything but directories, skipping SKIP_DIRS. */
function findArgs(): string[] {
  const skip = [...SKIP_DIRS].flatMap((dir, i) => (i ? ["-o", "-name", dir] : ["-name", dir]));
  return [".", "-mindepth", "1", "(", "-type", "d", "(", ...skip, ")", "-prune", ")", "-o", "(", "!", "-type", "d", "-print", ")"];
}

/** Runs a file lister in `base` and yields the paths it prints, one per line (relative, maybe "./"-prefixed). */
async function* listFiles(spec: SpawnSpec, base: string, signal: AbortSignal): AsyncGenerator<{ rel: string; abs: string }> {
  // A sandbox changes to `base` itself, which may exist only there (its /tmp).
  const child = spawn(spec.file, spec.args, { cwd: spec.cwd, env: spec.env, signal, stdio: ["ignore", "pipe", "ignore"] });
  child.on("error", () => {}); // Aborted or missing; the stream simply ends.
  let pending = "";
  let read = 0;
  try {
    for await (const chunk of child.stdout) {
      read += chunk.length;
      const lines = (pending + chunk.toString("utf8")).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) if (line) yield entry(base, line);
      if (read > MAX_LISTING_CHARS) break;
    }
    if (pending) yield entry(base, pending);
  } finally {
    child.kill();
  }
}

function entry(base: string, line: string): { rel: string; abs: string } {
  const rel = line.startsWith("./") ? line.slice(2) : line;
  return { rel, abs: path.join(base, rel) };
}

function ripgrepArgs(input: GrepInput, target: string): string[] {
  const args = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "300", "--max-columns-preview"];
  if (input.files_only) args.push("--files-with-matches");
  if (input.ignore_case) args.push("--ignore-case");
  if (input.context) args.push("--context", String(input.context));
  if (input.glob) args.push("--glob", input.glob);
  args.push("--regexp", input.pattern, "--", target);
  return args;
}

function grepArgs(input: GrepInput, target: string): string[] {
  const args = ["-r", "-n", "-I", "-E"];
  for (const dir of SKIP_DIRS) args.push(`--exclude-dir=${dir}`);
  if (input.files_only) args.push("-l");
  if (input.ignore_case) args.push("-i");
  if (input.context) args.push("-C", String(input.context));
  if (input.glob) args.push(`--include=${path.basename(input.glob)}`);
  args.push("-e", input.pattern, "--", target);
  return args;
}

interface SearchResult {
  output: string;
  code: number | null;
  missing: boolean;
}

/** Runs a search binary without a shell, so the pattern is never shell-interpreted. */
function runSearch(spec: SpawnSpec, cwd: string, signal: AbortSignal): Promise<SearchResult> {
  return new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, { cwd, env: spec.env, signal, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS * 4) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err: NodeJS.ErrnoException) =>
      resolve({ output: err.message, code: null, missing: err.code === "ENOENT" }),
    );
    child.on("close", (code) => resolve({ output, code, missing: notInstalled(spec.file, code, output) }));
  });
}

/** Whether a sandboxed run failed because the program isn't there: bwrap or the container runtime says so. */
function notInstalled(runner: string, code: number | null, output: string): boolean {
  if (runner === "bwrap") return code === 1 && /^bwrap: execvp /m.test(output);
  if (runner === "podman" || runner === "docker") return (code === 126 || code === 127) && /executable file not found|no such file or directory/i.test(output);
  return false;
}
