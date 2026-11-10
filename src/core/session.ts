import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./dirs.js";
import { SUMMARY_PREFIX } from "./context.js";
import { privateDir, privateFile, privateTree } from "./private.js";
import { type HistoryChange, type Message, messageText } from "./history.js";

/**
 * Sessions are append-only JSONL logs, one file per conversation:
 *
 *   {"type":"meta", "id", "cwd", "model", "endpoint"?, "created"}
 *   {"type":"append", "message": {...}}        one per message added
 *   {"type":"replace", "messages": [...]}      after compaction or /clear
 *   {"type":"model", "model", "endpoint"?}     when the user switches model or endpoint
 *   {"type":"name", "name"}                    when the user names the session (/name)
 *
 * Replaying the log rebuilds the conversation (without the system prompt,
 * which is regenerated on resume). Appending instead of rewriting means a
 * crash can lose at most the line being written.
 */

type Line =
  | { type: "meta"; id: string; cwd: string; model: string; endpoint?: string; name?: string; created: string }
  | { type: "append"; message: Message }
  | { type: "replace"; messages: Message[] }
  | { type: "model"; model: string; endpoint?: string }
  | { type: "name"; name: string };

export interface SessionInfo {
  id: string;
  cwd: string;
  model: string;
  endpoint?: string;
  created: string;
  updated: Date;
  file: string;
  /** First user message, for listings. */
  preview: string;
  /** Number of messages you sent. */
  turns: number;
  /** The session's name: set with /name, or else taken from the first message. */
  name: string;
  /** Whether the name was set with /name. */
  named: boolean;
}

export function sessionsDir(): string {
  return path.join(dataDir(), "sessions");
}

export class Session {
  private started = false;
  /** Whether this run has checked the file's permissions (older versions created it readable by others). */
  private secured = false;
  private currentModel: string;
  private currentEndpoint: string | undefined;
  private currentName: string | undefined;
  /** For an opened session: when it was last written to, before this run. */
  lastUsed: Date | undefined;

  private constructor(
    readonly id: string,
    readonly file: string,
    private meta: Extract<Line, { type: "meta" }>,
  ) {
    this.currentModel = meta.model;
    this.currentEndpoint = meta.endpoint;
    this.currentName = meta.name;
  }

  /** The model in use when the session was last saved. */
  get model(): string {
    return this.currentModel;
  }

  /** The folder the session works in. */
  get cwd(): string {
    return this.meta.cwd;
  }

  /** The configured endpoint in use when the session was last saved, if it was a named one. */
  get endpoint(): string | undefined {
    return this.currentEndpoint;
  }

  /** A new session. Its file is created on the first change, so empty sessions leave nothing behind. */
  static create(cwd: string, model: string, endpoint?: string): Session {
    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const id = `${stamp}-${randomBytes(2).toString("hex")}`;
    return new Session(id, path.join(sessionsDir(), `${id}.jsonl`), {
      type: "meta",
      id,
      cwd,
      model,
      endpoint,
      created: now.toISOString(),
    });
  }

  /** Opens an existing session for appending and returns its conversation so far. */
  static open(id: string): { session: Session; messages: Message[] } {
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    if (!fs.existsSync(file)) throw new Error(`No session ${id} in ${sessionsDir()}`);
    const { meta, messages, model, endpoint, name } = readLog(file);
    const session = new Session(meta.id, file, meta);
    session.lastUsed = fs.statSync(file).mtime;
    session.currentModel = model;
    session.currentEndpoint = endpoint;
    session.currentName = name;
    session.started = true;
    return { session, messages };
  }

  record(change: HistoryChange): void {
    this.write(change.type === "append" ? { type: "append", message: change.message } : change);
  }

  /** The name given with /name, if any. */
  get name(): string | undefined {
    return this.currentName;
  }

  /**
   * Names the session; listings and --resume <name> use it. Unlike other
   * changes this saves the session even before its first message: naming it
   * means you want to come back to it.
   */
  rename(name: string): void {
    this.currentName = name;
    this.write({ type: "name", name });
  }

  recordModel(model: string, endpoint: string | undefined): void {
    if (model === this.currentModel && endpoint === this.currentEndpoint) return;
    this.currentModel = model;
    this.currentEndpoint = endpoint;
    // Before the first message there's nothing to resume; the header will carry it.
    if (this.started) this.write({ type: "model", model, endpoint });
    else this.meta = { ...this.meta, model, endpoint };
  }

  private write(line: Line): void {
    const lines: Line[] = [];
    if (!this.started) {
      privateDir(path.dirname(path.dirname(this.file)));
      privateDir(path.dirname(this.file));
      lines.push(this.meta);
      this.started = true;
    }
    lines.push(line);
    // Sessions contain whole conversations: readable by you only.
    fs.appendFileSync(this.file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { mode: 0o600 });
    if (!this.secured) {
      privateFile(this.file);
      this.secured = true;
    }
  }
}

/** Makes existing session files private; files from older versions were readable by others. */
export function secureSessions(): void {
  privateTree(path.dirname(sessionsDir()), /^$/);
  privateTree(sessionsDir(), /\.jsonl$/);
  privateTree(path.join(path.dirname(sessionsDir()), "logs"), /\.jsonl$/);
}

/**
 * Sessions, newest first, optionally only those started in `cwd`. Reads
 * files newest first and stops after `limit` matches, so long histories
 * stay quick to list.
 */
export function listSessions(cwd?: string, limit = Infinity): SessionInfo[] {
  const dir = sessionsDir();
  if (!fs.existsSync(dir)) return [];
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => {
      const file = path.join(dir, name);
      return { file, updated: fs.statSync(file).mtime };
    })
    .sort((a, b) => b.updated.getTime() - a.updated.getTime());

  const infos: SessionInfo[] = [];
  for (const { file, updated } of files) {
    if (infos.length >= limit) break;
    try {
      const { meta, messages, model, endpoint, name } = readLog(file);
      if (cwd && meta.cwd !== cwd) continue;
      const users = messages.filter((m) => m.role === "user").map(messageText);
      const first = preview(users[0] ?? "");
      infos.push({ ...meta, model, endpoint, file, updated, preview: first, turns: users.length, named: name !== undefined, name: name ?? defaultName(first) });
    } catch {
      // Unreadable or foreign file; skip it.
    }
  }
  return infos;
}

/** A name from the first message, until the session is given one with /name: its first line, shortened. */
export function defaultName(firstMessage: string): string {
  const line = firstMessage.split(/(?<=[.!?])\s/)[0] ?? "";
  if (line.length <= 48) return line || "(no messages)";
  // Cut at 47 characters, dropping a word only if the cut splits it.
  let cut = line.slice(0, 47);
  if (!/\s/.test(line[47]!)) cut = cut.replace(/\s+\S*$/, "");
  return `${cut.trimEnd()}…`;
}

/**
 * Finds a session by id, or by name (ignoring case) when no id matches.
 * Throws with the candidates when a name is ambiguous.
 */
export function findSession(idOrName: string): string {
  if (fs.existsSync(path.join(sessionsDir(), `${idOrName}.jsonl`))) return idOrName;
  const wanted = idOrName.toLowerCase();
  const matches = listSessions().filter((s) => s.name.toLowerCase() === wanted);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new Error(`Several sessions are named "${idOrName}"; resume one by id:\n${matches.map((s) => `  ${s.id}  ${s.cwd}`).join("\n")}`);
  }
  throw new Error(`No session with the id or name "${idOrName}". smith --sessions lists them.`);
}

/**
 * Deletes a session: its log, and its tool log. Returns the files removed.
 * The caller makes sure it isn't the session being recorded.
 */
export function deleteSession(id: string): string[] {
  if (!/^[\w.-]+$/.test(id)) throw new Error(`Not a session id: ${id}`);
  const files = [path.join(sessionsDir(), `${id}.jsonl`), path.join(path.dirname(sessionsDir()), "logs", `${id}.jsonl`)];
  if (!fs.existsSync(files[0]!)) throw new Error(`No session ${id}.`);
  const removed: string[] = [];
  for (const file of files) {
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return removed;
}

/** One line from a session's first message; after compaction, the message following the summary. */
function preview(first: string): string {
  let text = first;
  if (text.startsWith(SUMMARY_PREFIX)) {
    const sep = text.indexOf("\n\n---\n\n");
    text = sep === -1 ? "(summarized conversation)" : text.slice(sep + 7);
  }
  return text.replace(/\s+/g, " ").trim().slice(0, 100);
}

function readLog(file: string): {
  meta: Extract<Line, { type: "meta" }>;
  messages: Message[];
  model: string;
  endpoint: string | undefined;
  name: string | undefined;
} {
  const raw = fs.readFileSync(file, "utf8").split("\n");
  let meta: Extract<Line, { type: "meta" }> | undefined;
  let messages: Message[] = [];
  let model: string | undefined;
  let endpoint: string | undefined;
  let name: string | undefined;
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
    else if (line.type === "name") name = line.name;
    else ({ model, endpoint } = line);
  }
  if (!meta) throw new Error(`Session log ${file} has no header`);
  name ??= meta.name;
  return model ? { meta, messages, model, endpoint, name } : { meta, messages, model: meta.model, endpoint: meta.endpoint, name };
}
