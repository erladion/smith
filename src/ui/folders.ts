import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_FOLDERS = 500;

/** Subfolders of `dir`, by name, case-insensitively sorted; hidden ones (".name") only if asked for. */
export function listFolders(dir: string, includeHidden = false): { names: string[]; error?: string } {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { names: [], error: (err as NodeJS.ErrnoException).code === "EACCES" ? "no permission to list this folder" : (err as Error).message };
  }
  const names = entries
    .filter((e) => (includeHidden || !e.name.startsWith(".")) && (e.isDirectory() || (e.isSymbolicLink() && isDirectory(path.join(dir, e.name)))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  return { names: names.slice(0, MAX_FOLDERS) };
}

export function isGitRepo(dir: string): boolean {
  return fs.existsSync(path.join(dir, ".git"));
}

/** A path with the home folder shown as ~. */
export function tildify(p: string): string {
  const home = os.homedir();
  return p === home ? "~" : p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/**
 * A path shortened to `max` characters by dropping folders from the left, so
 * the end (the project's own folder) stays visible: "…/work/webapp".
 */
export function shortPath(p: string, max: number): string {
  const shown = tildify(p);
  if (shown.length <= max) return shown;
  const parts = shown.split("/");
  let tail = parts.pop() ?? "";
  while (parts.length > 0 && tail.length + parts[parts.length - 1]!.length + 3 <= max) tail = `${parts.pop()}/${tail}`;
  return tail.length + 2 <= max ? `…/${tail}` : `…${tail.slice(tail.length - max + 1)}`;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
