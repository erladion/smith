import fs from "node:fs";
import path from "node:path";
import { privateDir, privateFile } from "./private.js";
import { sessionsDir } from "./session.js";

/** How the user's approval went for one tool call. */
export type ToolApproval =
  /** Read-only and inside the project: runs without asking. */
  | "not needed"
  /** Allowed earlier in the session with "always allow". */
  | "already allowed"
  | "allowed"
  | "allowed always"
  | "denied";

/** One tool call, as the agent reports it when the call is over. */
export interface ToolRun {
  /** When the call started (ISO 8601). */
  time: string;
  tool: string;
  /** The arguments as the model sent them, parsed when they were valid JSON. */
  input: unknown;
  /** Not set when the call failed before approval was considered (unknown tool, bad arguments). */
  approval?: ToolApproval;
  status: "ok" | "error" | "denied" | "invalid";
  /** How long the tool itself ran; waiting for approval isn't counted. */
  durationMs: number;
  output: string;
  /** The sub-agent that made the call, for calls made inside the task tool. */
  subagent?: string;
}

/** Output beyond this many characters is cut from the log (the session keeps all of it). */
const MAX_OUTPUT = 10_000;

/** Where tool logs are kept: one JSONL file per session, next to the sessions. */
export function toolLogDir(): string {
  return path.join(path.dirname(sessionsDir()), "logs");
}

export function toolLogFile(sessionId: string): string {
  return path.join(toolLogDir(), `${sessionId}.jsonl`);
}

/**
 * Appends every tool call to logs/<session id>.jsonl, one JSON object per
 * line, readable by you only. The session id is looked up per call, since
 * the TUI can switch sessions.
 */
export class ToolLog {
  private readonly secured = new Set<string>();

  constructor(
    private readonly sessionId: () => string,
    private readonly cwd: () => string,
  ) {}

  write(run: ToolRun): void {
    const session = this.sessionId();
    const file = toolLogFile(session);
    const output = run.output.length > MAX_OUTPUT ? run.output.slice(0, MAX_OUTPUT) : run.output;
    const entry = {
      time: run.time,
      session,
      cwd: this.cwd(),
      ...(run.subagent ? { subagent: run.subagent } : {}),
      tool: run.tool,
      input: run.input,
      ...(run.approval ? { approval: run.approval } : {}),
      status: run.status,
      durationMs: run.durationMs,
      output,
      ...(output.length < run.output.length ? { outputChars: run.output.length } : {}),
    };
    try {
      if (!this.secured.has(file)) privateDir(toolLogDir());
      fs.appendFileSync(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
      if (!this.secured.has(file)) {
        privateFile(file);
        this.secured.add(file);
      }
    } catch {
      // A full disk or unwritable folder mustn't stop the agent; the session still has the call.
    }
  }
}
