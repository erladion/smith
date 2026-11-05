import type OpenAI from "openai";
import { z } from "zod";
import type { DiffLine } from "./diff.js";
import type { Sandbox } from "./sandbox.js";

export interface ToolContext {
  /** Root directory the agent works in; file tools are confined to it. */
  cwd: string;
  /** Aborted when the user interrupts; long-running tools should stop. */
  signal: AbortSignal;
  /** Where shell commands run. Defaults to no sandbox. */
  sandbox?: Sandbox;
  /** File tools call these around each write, so the turn can be undone. */
  beforeWrite?: (file: string) => Promise<void>;
  afterWrite?: (file: string, content: string) => void;
}

export interface ToolResult {
  /** What the model sees. */
  content: string;
  isError?: boolean;
  /** For file changes: the diff, shown to the user instead of `content`. */
  diff?: DiffLine[];
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Read-only tools run without asking the user. */
  readOnly: boolean;
  /** Runs inside the sandbox when one is active (shown in the approval prompt). */
  sandboxed?: boolean;
  /** One-line description of a call, shown in the transcript and approval prompt. */
  summarize: (input: z.output<S>) => string;
  /**
   * For read-only tools: why this particular call needs approval anyway
   * (e.g. it reads outside the project), or undefined if it doesn't.
   */
  approvalReason?: (input: z.output<S>, ctx: ToolContext) => Promise<string | undefined>;
  /**
   * The change the call would make, shown in the approval prompt. Throwing
   * means the call would fail; the error goes to the model without asking.
   */
  preview?: (input: z.output<S>, ctx: ToolContext) => Promise<DiffLine[]>;
  run: (input: z.output<S>, ctx: ToolContext) => Promise<ToolResult>;
}

/** Defines a tool with a typed input, then erases the type so tools fit in one list. */
export function defineTool<S extends z.ZodObject>(tool: ToolDef<S>): ToolDef {
  return tool as unknown as ToolDef;
}

/** Converts a tool to the OpenAI chat-completions `tools` entry. */
export function toApiTool(tool: ToolDef): OpenAI.Chat.Completions.ChatCompletionTool {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters },
  };
}

/** One-line description of a recorded call, for replaying a saved session. */
export function describeCall(tools: ToolDef[], name: string, args: string): string {
  const tool = tools.find((t) => t.name === name);
  if (tool) {
    try {
      const parsed = tool.schema.safeParse(JSON.parse(args || "{}"));
      if (parsed.success) return tool.summarize(parsed.data);
    } catch {
      // Fall through to the raw arguments.
    }
  }
  return truncate(args, 200);
}

/** Keeps the head and tail of long output so the model sees both ends. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const dropped = text.length - 2 * half;
  return `${text.slice(0, half)}\n\n[... ${dropped} characters truncated ...]\n\n${text.slice(-half)}`;
}
