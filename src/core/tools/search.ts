import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { globToRegExp } from "../glob.js";
import { resolveInRoot } from "../paths.js";
import { defineTool, type ToolResult, truncate } from "../tool.js";

const MAX_OUTPUT_CHARS = 15_000;
const MAX_GLOB_RESULTS = 200;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".venv", "__pycache__"]);

const grepSchema = z.object({
  pattern: z.string().min(1).describe("Regular expression to search for"),
  path: z.string().optional().describe("File or directory to search, relative to the working directory (default: all)"),
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
  async run(input, ctx) {
    const target = input.path ? path.relative(ctx.cwd, await resolveInRoot(ctx.cwd, input.path)) || "." : ".";
    const rg = await runSearch("rg", ripgrepArgs(input, target), ctx.cwd, ctx.signal);
    const result = rg.missing ? await runSearch("grep", grepArgs(input, target), ctx.cwd, ctx.signal) : rg;

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
    "Skips .git, node_modules and common build directories.",
  schema: z.object({
    pattern: z.string().min(1).describe("Glob pattern, relative to path"),
    path: z.string().optional().describe("Directory to search from, relative to the working directory (default: .)"),
  }),
  readOnly: true,
  summarize: ({ pattern, path: p }) => (p ? `${pattern} in ${p}` : pattern),
  async run({ pattern, path: p }, ctx): Promise<ToolResult> {
    if (path.isAbsolute(pattern) || pattern.split("/").includes("..")) {
      return { content: "The pattern must be relative and must not contain '..'. Use path to choose where to search.", isError: true };
    }
    const base = await resolveInRoot(ctx.cwd, p ?? ".");
    const regex = globToRegExp(pattern);
    const matches: { file: string; mtime: number }[] = [];

    for await (const { rel, abs } of walk(base, ctx.signal)) {
      if (!regex.test(rel)) continue;
      const stat = await fs.stat(abs).catch(() => null);
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
function runSearch(cmd: string, args: string[], cwd: string, signal: AbortSignal): Promise<SearchResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT_CHARS * 4) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err: NodeJS.ErrnoException) =>
      resolve({ output: err.message, code: null, missing: err.code === "ENOENT" }),
    );
    child.on("close", (code) => resolve({ output, code, missing: false }));
  });
}
