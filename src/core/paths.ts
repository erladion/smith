import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolves a model-supplied path against the working directory and rejects
 * anything that lands outside it: `..`, absolute paths elsewhere, and
 * symlinks that point out of the root.
 */
export async function resolveInRoot(root: string, requested: string): Promise<string> {
  const target = path.resolve(root, requested);
  assertInside(root, target, requested);

  // Resolve symlinks on the deepest part of the path that exists, so a link
  // inside the root cannot redirect a read or write outside it.
  const realRoot = await fs.realpath(root);
  let existing = target;
  for (;;) {
    try {
      assertInside(realRoot, await fs.realpath(existing), requested);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return target;
}

/**
 * Rejects writes into .git. Git config and hooks run code the next time the
 * user runs git, outside any sandbox, so the agent may not change them.
 */
export function assertWritable(root: string, target: string): void {
  const [first] = path.relative(root, target).split(path.sep);
  if (first === ".git") {
    throw new Error("Refusing to modify .git: git runs its config and hooks outside the sandbox. Ask the user to make git changes.");
  }
}

function assertInside(root: string, target: string, requested: string): void {
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the working directory: ${requested}`);
  }
}
