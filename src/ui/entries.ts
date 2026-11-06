import type { DiffLine } from "../core/diff.js";
import type { NoticeLevel } from "../core/events.js";
import { markdownLines } from "./markdown.js";
import type { Color, Line, Style } from "./style.js";
import { lineWidth, prefixed, truncate, wrap } from "./text.js";

/** Something printed into the transcript. */
export type Entry =
  | {
      kind: "banner";
      model: string;
      server: string;
      cwd: string;
      session: string;
      resumed: boolean;
      sandbox: { active: boolean; description: string };
      /** Instruction files in use, for display. */
      instructions: string[];
      skills: string[];
      /** Agent Smith's welcome line. */
      greeting?: string;
    }
  | { kind: "user"; text: string }
  /** Assistant text, rendered as Markdown. */
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool"; name: string; summary: string; output: string; isError: boolean; diff?: DiffLine[] }
  | { kind: "notice"; level: NoticeLevel; text: string }
  /** Quiet information, e.g. how long a turn took. */
  | { kind: "meta"; text: string };

export const DIM: Style = { dim: true };
export const REASONING: Style = { dim: true, italic: true };
const NOTICE_COLORS: Record<NoticeLevel, Color> = { info: "blue", warn: "yellow", error: "red" };
const PREVIEW_LINES = 4;
const DIFF_LINES = 14;

/** The lines for an entry, starting with a blank separator line (except the banner). */
export function entryLines(entry: Entry, width: number): Line[] {
  switch (entry.kind) {
    case "banner":
      return bannerLines(entry, width);
    case "user":
      return [[], ...prefixed([{ text: "› ", style: { color: "cyan", bold: true } }], [{ text: "  " }], [{ text: entry.text }], width)];
    case "text":
      return [[], ...markdownLines(entry.text, width)];
    case "reasoning":
      return [[], ...wrap([{ text: entry.text, style: REASONING }], width)];
    case "notice":
      return [[], ...wrap([{ text: entry.text, style: { color: NOTICE_COLORS[entry.level] } }], width)];
    case "tool":
      return [[], ...toolLines(entry, width)];
    case "meta":
      return [[], ...wrap([{ text: entry.text, style: DIM }], width)];
  }
}

function bannerLines(b: Extract<Entry, { kind: "banner" }>, width: number): Line[] {
  const sandbox: Line = b.sandbox.active
    ? [{ text: `✓ ${b.sandbox.description}`, style: { color: "green" } }]
    : [{ text: `⚠ shell commands are ${b.sandbox.description}`, style: { color: "red" } }];
  return box(
    [
      [{ text: "Agent Smith", style: { bold: true, color: "cyan" } }],
      ...(b.greeting ? ([[{ text: b.greeting, style: { color: "green", italic: true } }], []] as Line[]) : []),
      [{ text: `model   ${b.model}`, style: DIM }],
      [{ text: `server  ${b.server}`, style: DIM }],
      [{ text: `cwd     ${b.cwd}`, style: DIM }],
      [{ text: `session ${b.session}${b.resumed ? " (resumed)" : ""}`, style: DIM }],
      ...(b.instructions.length ? [[{ text: `rules   ${b.instructions.join(", ")}`, style: DIM }]] : []),
      ...(b.skills.length ? [[{ text: `skills  ${b.skills.join(", ")}`, style: DIM }]] : []),
      sandbox,
      [{ text: "/help for commands · esc interrupts · ctrl+c quits", style: DIM }],
    ],
    "cyan",
    width,
  );
}

function toolLines(t: Extract<Entry, { kind: "tool" }>, width: number): Line[] {
  const header = truncate(
    [
      { text: "● ", style: { color: t.isError ? "red" : "green" } },
      { text: t.name, style: { bold: true } },
      { text: t.summary ? ` ${t.summary}` : "", style: DIM },
    ],
    width,
  );
  if (t.diff && !t.isError) {
    return [header, ...diffView(t.diff, width, DIFF_LINES).map((line): Line => [{ text: "  " }, ...line])];
  }
  const lines = t.output.replace(/\n+$/, "").split("\n");
  const style: Style = t.isError ? { color: "red" } : DIM;
  const preview = lines.slice(0, PREVIEW_LINES).map((text, i) =>
    truncate([{ text: i === 0 ? "  └ " : "    ", style: DIM }, { text, style }], width),
  );
  const hidden = lines.length - PREVIEW_LINES;
  if (hidden > 0) preview.push([{ text: `    … ${hidden} more line${hidden === 1 ? "" : "s"}`, style: DIM }]);
  return [header, ...preview];
}

/**
 * A diff as colored lines with line numbers: green additions, red removals,
 * dim context. Shows at most `maxLines`.
 */
export function diffView(diff: DiffLine[], width: number, maxLines: number): Line[] {
  const numbers = diff.map((d) => (d.kind === "remove" ? d.oldLine : d.kind === "gap" ? 0 : d.newLine));
  const numWidth = String(Math.max(1, ...numbers)).length;
  const num = (n: number) => ({ text: `${String(n).padStart(numWidth)} `, style: DIM });
  const lines = diff.map((d): Line => {
    switch (d.kind) {
      case "gap":
        return [{ text: `${" ".repeat(numWidth)}   ⋯ ${d.count} unchanged line${d.count === 1 ? "" : "s"}`, style: DIM }];
      case "add":
        return [num(d.newLine), { text: "+ ", style: { color: "green" } }, { text: d.text, style: { color: "green" } }];
      case "remove":
        return [num(d.oldLine), { text: "- ", style: { color: "red" } }, { text: d.text, style: { color: "red" } }];
      case "context":
        return [num(d.newLine), { text: "  " }, { text: d.text, style: DIM }];
    }
  });
  const shown = lines.slice(0, maxLines).map((l) => truncate(l, width - 2));
  if (lines.length > maxLines) shown.push([{ text: `… ${lines.length - maxLines} more diff lines`, style: DIM }]);
  return shown;
}

/**
 * Draws a rounded box around content lines. The box is as wide as its widest
 * line, or the full width with `fill`; longer lines are cut off.
 */
export function box(content: Line[], color: Color, width: number, fill = false): Line[] {
  const max = Math.max(1, width - 4);
  const inner = fill ? max : Math.min(max, Math.max(1, ...content.map(lineWidth)));
  const border: Style = { color };
  const top: Line = [{ text: `╭${"─".repeat(inner + 2)}╮`, style: border }];
  const bottom: Line = [{ text: `╰${"─".repeat(inner + 2)}╯`, style: border }];
  const body = content.map((line): Line => {
    const cut = truncate(line, inner);
    return [{ text: "│ ", style: border }, ...cut, { text: " ".repeat(inner - lineWidth(cut)) }, { text: " │", style: border }];
  });
  return [top, ...body, bottom];
}
