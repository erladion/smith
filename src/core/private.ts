import fs from "node:fs";
import path from "node:path";

/**
 * The agent's own data (sessions hold whole conversations, including file
 * contents and command output) is for your eyes only: folders 700, files 600.
 */

/** Creates `dir` (and its missing parents, with normal permissions) and makes `dir` itself private. */
export function privateDir(dir: string): void {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  tighten(dir, 0o700);
}

/** Makes an existing file private (files from older versions were created readable by others). */
export function privateFile(file: string): void {
  tighten(file, 0o600);
}

/** Tightens a folder and the files directly in it, e.g. the sessions folder at startup. */
export function privateTree(dir: string, filePattern: RegExp): void {
  if (!fs.existsSync(dir)) return;
  tighten(dir, 0o700);
  for (const name of fs.readdirSync(dir)) {
    if (filePattern.test(name)) tighten(path.join(dir, name), 0o600);
  }
}

function tighten(p: string, mode: number): void {
  try {
    if ((fs.statSync(p).mode & 0o777) !== mode) fs.chmodSync(p, mode);
  } catch {
    // Missing, or not ours to change; nothing to tighten.
  }
}
