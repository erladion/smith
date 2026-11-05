import fs from "node:fs/promises";

interface FileChange {
  /** Content before the turn's first change; null if the file didn't exist. */
  before: string | null;
  /** Content after the turn's last change. */
  after: string | null;
}

/**
 * What one turn changed through the file tools, so it can be put back.
 * Changes made by shell commands can't be seen here; `untracked` records
 * which such tools ran, so the user can be told.
 */
export class Checkpoint {
  readonly files = new Map<string, FileChange>();
  readonly untracked = new Set<string>();

  /** Call before writing `file`; remembers its content the first time. */
  async beforeWrite(file: string): Promise<void> {
    if (!this.files.has(file)) this.files.set(file, { before: await readOrNull(file), after: null });
  }

  afterWrite(file: string, content: string): void {
    const change = this.files.get(file);
    if (change) change.after = content;
  }
}

export interface RestoreResult {
  restored: string[];
  /** Files left alone because they changed after the agent wrote them. */
  skipped: string[];
}

/**
 * Puts files back as they were before the checkpoint. A file that was
 * changed since (by you, or by a command) is left alone rather than
 * overwriting that change.
 */
export async function restore(checkpoint: Checkpoint): Promise<RestoreResult> {
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const [file, change] of checkpoint.files) {
    if ((await readOrNull(file)) !== change.after) {
      skipped.push(file);
      continue;
    }
    if (change.before === null) await fs.rm(file, { force: true });
    else await fs.writeFile(file, change.before, "utf8");
    restored.push(file);
  }
  return { restored, skipped };
}

async function readOrNull(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
