import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HistoryChange, Message } from "./history.js";

/**
 * Sessions are append-only JSONL logs, one file per conversation:
 *
 *   {"type":"meta", "id", "cwd", "model", "created"}
 *   {"type":"append", "message": {...}}        one per message added
 *   {"type":"replace", "messages": [...]}      after compaction or /clear
 *   {"type":"model", "model"}                  when the user switches model
 *
 * Replaying the log rebuilds the conversation (without the system prompt,
 * which is regenerated on resume). Appending instead of rewriting means a
 * crash can lose at most the line being written.
 */

type Line =
  | { type: "meta"; id: string; cwd: string; model: string; created: string }
  | { type: "append"; message: Message }
  | { type: "replace"; messages: Message[] }
  | { type: "model"; model: string };

export interface SessionInfo {
  id: string;
  cwd: string;
  model: string;
  created: string;
  updated: Date;
  file: string;
  /** First user message, for listings. */
  preview: string;
}

export function sessionsDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "agent", "sessions");
}

export class Session {
  private started = false;
  private currentModel: string;

  private constructor(
    readonly id: string,
    readonly file: string,
    private meta: Extract<Line, { type: "meta" }>,
  ) {
    this.currentModel = meta.model;
  }

  /** The model in use when the session was last saved. */
  get model(): string {
    return this.currentModel;
  }

  /** A new session. Its file is created on the first change, so empty sessions leave nothing behind. */
  static create(cwd: string, model: string): Session {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const id = `${stamp}-${randomBytes(2).toString("hex")}`;
    return new Session(id, path.join(sessionsDir(), `${id}.jsonl`), {
      type: "meta",
      id,
      cwd,
      model,
      created: now.toISOString(),
    });
  }

  /** Opens an existing session for appending and returns its conversation so far. */
  static open(id: string): { session: Session; messages: Message[] } {
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`No session ${id} in ${sessionsDir()}`);
    const { meta, messages, model } = readLog(file);
    const session = new Session(meta.id, file, meta);
    session.currentModel = model;
    session.started = true;
    return { session, messages };
  }

  record(change: HistoryChange): void {
    this.write(change.type === "append" ? { type: "append", message: change.message } : change);
  }

  recordModel(model: string): void {
    if (model === this.currentModel) return;
    this.currentModel = model;
    // Before the first message there's nothing to resume; the header will carry it.
    if (this.started) this.write({ type: "model", model });
    else this.meta.model = model;
  }

  private write(line: Line): void {
    const lines: Line[] = [];
    if (!this.started) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      lines.push(this.meta);
      this.started = true;
    }
    lines.push(line);
    fs.appendFileSync(this.file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
}

/** Sessions, newest first, optionally only those started in `cwd`. */
export function listSessions(cwd?: string): SessionInfo[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const infos: SessionInfo[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    try {
      const { meta, messages, model } = readLog(file);
      if (cwd && meta.cwd !== cwd) continue;
      const firstUser = messages.find((m) => m.role === "user");
      const preview = typeof firstUser?.content === "string" ? firstUser.content : "";
      infos.push({ ...meta, model, file, updated: fs.statSync(file).mtime, preview: preview.replace(/\s+/g, " ").slice(0, 80) });
    } catch {
      // Unreadable or foreign file; skip it.
    }
  }
  return infos.sort((a, b) => b.updated.getTime() - a.updated.getTime());
}

function readLog(file: string): { meta: Extract<Line, { type: "meta" }>; messages: Message[]; model: string } {
  const raw = fs.readFileSync(file, "utf8").split("\n");
  let meta: Extract<Line, { type: "meta" }> | undefined;
  let messages: Message[] = [];
  let model: string | undefined;
  for (const [i, text] of raw.entries()) {
    if (!text.trim()) continue;
    let line: Line;
    try {
      line = JSON.parse(text) as Line;
    } catch {
      // Only the last line can be half-written (crash mid-append); anything else is corruption.
      if (i >= raw.length - 2) break;
      throw new Error(`Corrupt session log ${file} at line ${i + 1}`);
    }
    if (line.type === "meta") meta = line;
    else if (line.type === "append") messages.push(line.message);
    else if (line.type === "replace") messages = [...line.messages];
    else model = line.model;
  }
  if (!meta) throw new Error(`Session log ${file} has no header`);
  return { meta, messages, model: model ?? meta.model };
}
