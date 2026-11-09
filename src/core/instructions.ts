import fs from "node:fs";
import path from "node:path";
import { configPath } from "./config.js";

export interface InstructionFile {
  path: string;
  content: string;
}

const MAX_CHARS = 20_000;

/** The repository root containing `cwd` (the nearest folder with .git), if any. */
export function findRepoRoot(cwd: string): string | undefined {
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return undefined;
  }
}

/**
 * Instruction files for the system prompt, most general first:
 *
 * 1. ~/.config/smith/AGENTS.md, your personal instructions for every project.
 * 2. AGENTS.md in each folder from the repository root down to `cwd`, so a
 *    subproject can add to the repository's instructions. Outside a
 *    repository, only `cwd` is checked.
 *
 * In each folder, CLAUDE.md is used if there's no AGENTS.md, so projects set
 * up for other agents work too.
 */
export function loadInstructions(cwd: string): InstructionFile[] {
  const files: InstructionFile[] = [];
  const personal = path.join(path.dirname(configPath()), "AGENTS.md");
  const add = (file: string) => {
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8").trim();
    } catch {
      return false;
    }
    if (content.length > MAX_CHARS) {
      content = `${content.slice(0, MAX_CHARS)}\n\n[Truncated: the file is longer than ${MAX_CHARS} characters.]`;
    }
    if (content) files.push({ path: file, content });
    return true;
  };

  add(personal);
  const root = findRepoRoot(cwd) ?? cwd;
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    dirs.unshift(dir);
    if (dir === root || path.dirname(dir) === dir) break;
  }
  for (const dir of dirs) {
    if (!add(path.join(dir, "AGENTS.md"))) add(path.join(dir, "CLAUDE.md"));
  }
  return files;
}
