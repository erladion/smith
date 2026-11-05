import fs from "node:fs";
import path from "node:path";

/** Finds an executable on PATH without running it. */
export function which(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** Faster alternatives to standard tools, when installed. */
export interface FastTools {
  /** ripgrep: faster than grep -r, and respects .gitignore. */
  rg?: string;
  /** fd: faster than find. Debian and Ubuntu install it as fdfind. */
  fd?: string;
  /** jq: for reading JSON in shell commands. */
  jq?: string;
}

let found: FastTools | undefined;

/** Looks the tools up once; later calls reuse the result. */
export function fastTools(): FastTools {
  found ??= { rg: which("rg"), fd: which("fd") ?? which("fdfind"), jq: which("jq") };
  return found;
}

/** For tests: look again (e.g. after changing PATH). */
export function resetFastTools(): void {
  found = undefined;
}
