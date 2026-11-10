import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isHiddenFromAgent, type Sandbox } from "./sandbox.js";

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

export interface ReadTarget {
  path: string;
  /** Outside the project folder: reading it needs the user's approval. */
  outside: boolean;
  /** Where the file really is, when that differs from `path` (the sandbox's private /tmp). */
  hostPath?: string;
}

/**
 * Resolves a path for reading. Unlike writes, reads may leave the project
 * (absolute paths, `..`, `~/`), but never into places hidden from the agent,
 * checked both as written and with symlinks resolved.
 *
 * With a sandbox, /tmp and /var/tmp are the session's private ones (where
 * commands leave build logs and the like): readable without asking, unless
 * a symlink there leads somewhere else. In a container, everything outside
 * the project is the container's own, and reading it never asks.
 */
export async function resolveForRead(root: string, requested: string, sandbox?: Sandbox): Promise<ReadTarget> {
  const expanded = requested === "~" || requested.startsWith("~/") ? path.join(os.homedir(), requested.slice(1)) : requested;
  const target = path.resolve(root, expanded);
  const real = await realpathAllowingMissing(target);
  if (isInside(await fs.realpath(root), real)) return { path: target, outside: false };
  const temp = sandbox?.sandboxPath(target, root);
  if (temp && (!temp.host || !temp.root)) return { path: target, outside: false };
  if (temp?.host && temp.root) {
    const realTemp = await realpathAllowingMissing(temp.host);
    if (isInside(await fs.realpath(temp.root), realTemp)) return { path: target, outside: false, hostPath: temp.host };
    if (isHiddenFromAgent(realTemp)) throw new Error(`${requested} is off limits: it leads to a place hidden from the agent.`);
    return { path: target, outside: true, hostPath: temp.host };
  }
  if (isHiddenFromAgent(target) || isHiddenFromAgent(real)) {
    throw new Error(`${requested} is off limits: credentials, system files and the agent's own data are hidden from the agent.`);
  }
  return { path: target, outside: true };
}

/** realpath for a path whose last parts may not exist yet. */
async function realpathAllowingMissing(target: string): Promise<string> {
  let existing = target;
  let rest = "";
  for (;;) {
    try {
      return path.join(await fs.realpath(existing), rest);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = path.dirname(existing);
      if (parent === existing) return target;
      rest = path.join(path.basename(existing), rest);
      existing = parent;
    }
  }
}

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return !(rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel));
}

function assertInside(root: string, target: string, requested: string): void {
  const rel = path.relative(root, target);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`Path is outside the working directory: ${requested}`);
  }
}
