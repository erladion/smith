import type { ApprovalRequest } from "../core/agent.js";
import type { Theme } from "../core/config.js";
import type { Sandbox } from "../core/sandbox.js";
import type { Question } from "../core/tools/ask.js";
import type { Color, Line } from "../tui/style.js";
import { lineWidth, prefixed, truncate, wrap } from "../tui/text.js";
import { box, DIM, diffView } from "./entries.js";

// Parts of the live region that are drawn from plain data.

export const SPINNERS: Record<Theme, { frames: string[]; color: Color }> = {
  plain: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], color: "yellow" },
  // Half-width katakana, one column wide like the braille dots.
  matrix: { frames: [..."ﾊﾐﾋｰｳｼﾅﾓﾆｻﾜﾂｵﾘｱﾎﾃﾏｹﾒｴｶｷﾑﾕﾗｾﾈｽﾀﾇﾍ"], color: "green" },
};

/** The "Allow bash?" box, with the change previewed in as many of the screen's `rows` as fit. */
export function approvalBox(req: ApprovalRequest, width: number, rows: number): Line[] {
  const content: Line[] = [[{ text: `Allow ${req.tool}?`, style: { bold: true } }]];
  const summary = wrap([{ text: req.summary }], width - 4);
  content.push(...summary.slice(0, 12));
  if (req.note) content.push([{ text: req.note, style: { color: "yellow" } }]);
  if (summary.length > 12) content.push([{ text: `… ${summary.length - 12} more lines`, style: DIM }]);
  if (req.preview) {
    // Leave room for the rest of the screen, but show as much of the change as fits.
    const room = Math.max(6, rows - content.length - 10);
    content.push([], ...diffView(req.preview, width - 4, room), []);
  }
  if (req.sandbox) {
    content.push([{ text: `${req.sandbox.active ? "✓" : "⚠"} ${req.sandbox.description}`, style: { color: req.sandbox.active ? "green" : "red" } }]);
  }
  content.push([
    { text: "y", style: { color: "green" } },
    { text: " yes · ", style: DIM },
    { text: "a", style: { color: "green" } },
    { text: ` always allow ${req.tool} this session · `, style: DIM },
    { text: "n", style: { color: "red" } },
    { text: " no · ", style: DIM },
    { text: "esc", style: { color: "red" } },
    { text: " no and interrupt", style: DIM },
  ]);
  return box(content, "yellow", width, true);
}

/** The agent's question, its suggested answers (the `selected` one highlighted), and the keys. */
export function questionBox(q: Question, selected: number, width: number): Line[] {
  const content: Line[] = wrap([{ text: q.question, style: { bold: true } }], width - 4);
  if (q.options.length) {
    content.push([]);
    q.options.forEach((option, i) => {
      const on = i === selected;
      content.push(...prefixed([{ text: on ? "› " : "  ", style: { color: "cyan" } }, { text: `${i + 1}. `, style: DIM }], [{ text: "     " }], [{ text: option, style: on ? { color: "cyan", bold: true } : {} }], width - 4));
    });
  }
  content.push([]);
  const keys = q.options.length
    ? `↑↓ and enter, or 1-${q.options.length}, picks · or type your own answer below · esc dismisses`
    : "type your answer below · esc dismisses";
  content.push(...wrap([{ text: keys, style: DIM }], width - 4));
  return box(content, "cyan", width, true);
}

export interface Status {
  endpoint: string | undefined;
  model: string;
  reasoning: string;
  context: { tokens: number; limit?: number } | null;
  sandbox: Sandbox;
  /** Working: esc interrupts. */
  busy: boolean;
  /** An agent turn is running, so enter queues a message. */
  queueing: boolean;
  /** Commands running in the background. */
  jobs?: number;
  /** Fills spare room at the right end with this many columns of something, e.g. a code stream. */
  filler?: (width: number) => string;
}

/** The bottom line: endpoint, model, reasoning, context use, sandbox, and what keys do now. */
export function statusLine(status: Status, width: number): Line {
  const k = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));
  const { context, sandbox } = status;
  const parts = [status.endpoint, status.model, `reasoning ${status.reasoning}`];
  if (context) {
    parts.push(context.limit ? `${Math.round((100 * context.tokens) / context.limit)}% of ${k(context.limit)} context` : `${k(context.tokens)} tokens`);
  }
  if (sandbox.active) parts.push(`${sandbox.type === "container" ? "container" : "sandbox"}, net ${sandbox.network ? "on" : "off"}`);
  if (status.jobs) parts.push(`${status.jobs} background job${status.jobs === 1 ? "" : "s"}`);
  if (status.busy) parts.push(status.queueing ? "esc to interrupt · enter queues" : "esc to interrupt");
  const line: Line = sandbox.active ? [] : [{ text: "unsandboxed · ", style: { color: "red" } }];
  line.push({ text: parts.filter(Boolean).join(" · "), style: DIM });
  const room = Math.min(24, width - lineWidth(line) - 3);
  if (status.filler && room >= 6) line.push({ text: " ".repeat(width - lineWidth(line) - room) }, { text: status.filler(room), style: { color: "green", dim: true } });
  return truncate(line, width);
}

/** The spinner text for the tools in flight ("bash ls -la" each): one tool, or how many run in parallel. */
export function runningLabel(running: string[]): string {
  if (running.length === 0) return "Thinking…";
  if (running.length === 1) return running[0]!;
  return `${running.length} tools in parallel: ${running.map((l) => l.split(" ")[0]).join(", ")}`;
}
