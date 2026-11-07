import type { Line, Style } from "./style.js";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Removes escape sequences and control characters, so text from the model or
 * from tool output can't move the cursor, recolor the screen or hide part of
 * an approval prompt. Keeps newlines; tabs become four spaces.
 */
export function sanitize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "") // CSI: colors, cursor movement
    .replace(/\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g, "") // OSC/DCS strings: titles, hyperlinks
    .replace(/\t/g, "    ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

/** User-perceived characters: an emoji with modifiers or a letter with accents is one. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

// East Asian wide and fullwidth ranges, plus the emoji blocks terminals draw two columns wide.
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0],
  [0x23f3, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f],
  [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5],
  [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f5], [0x26fa, 0x26fd],
  [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x2753, 0x2757],
  [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f],
  [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];

function isWide(cp: number): boolean {
  let lo = 0;
  let hi = WIDE.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = WIDE[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

/** Columns one grapheme takes in a terminal: 0, 1 or 2. */
export function graphemeWidth(g: string): number {
  const cp = g.codePointAt(0) ?? 0;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (ZERO_WIDTH.test(g)) return 0;
  // An emoji presentation selector makes even a narrow symbol two columns wide.
  if (g.includes("️")) return 2;
  return isWide(cp) ? 2 : 1;
}

/** Columns a string takes. Assumes sanitized text without newlines. */
export function textWidth(text: string): number {
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let width = 0;
  for (const g of graphemes(text)) width += graphemeWidth(g);
  return width;
}

export function lineWidth(line: Line): number {
  let width = 0;
  for (const span of line) width += textWidth(flat(span.text));
  return width;
}

/** Sanitized, on one line. */
function flat(text: string): string {
  return sanitize(text).replace(/\n/g, " ");
}

/**
 * Word-wraps a line to `width` columns. Newlines in the text start new lines;
 * spaces at a wrap point are dropped, so wrapped lines don't start with one;
 * words longer than the width are split.
 */
export function wrap(line: Line, width: number): Line[] {
  width = Math.max(1, width);
  const lines: Line[] = [];
  let current: Line = [];
  let used = 0;
  let afterSoftBreak = false;

  const add = (text: string, style: Style | undefined) => {
    const last = current[current.length - 1];
    if (last && last.style === style) last.text += text;
    else current.push({ text, style });
    used += textWidth(text);
  };
  const newLine = (soft: boolean) => {
    lines.push(trimEnd(current));
    current = [];
    used = 0;
    afterSoftBreak = soft;
  };

  for (const span of line) {
    const parts = sanitize(span.text).split("\n");
    parts.forEach((part, i) => {
      if (i > 0) newLine(false);
      for (const token of part.match(/ +|[^ ]+/g) ?? []) {
        const w = textWidth(token);
        // An inverse space is the input cursor: it's content, not a place to break.
        if (token.startsWith(" ") && !span.style?.inverse) {
          if (afterSoftBreak && used === 0) continue;
          if (used + w <= width) add(token, span.style);
          else newLine(true);
          continue;
        }
        if (used + w > width && used > 0 && w <= width) newLine(true);
        if (used + w <= width) {
          add(token, span.style);
        } else {
          for (const g of graphemes(token)) {
            if (used + graphemeWidth(g) > width && used > 0) newLine(true);
            add(g, span.style);
          }
        }
        afterSoftBreak = false;
      }
    });
  }
  lines.push(trimEnd(current));
  return lines;
}

function trimEnd(line: Line): Line {
  const out = line.map((s) => ({ ...s }));
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    if (last.style?.inverse) break;
    last.text = last.text.replace(/ +$/, "");
    if (last.text) break;
    out.pop();
  }
  return out;
}

/** Wraps `content`, starting the first line with `first` and indenting the rest with `rest`. */
export function prefixed(first: Line, rest: Line, content: Line, width: number): Line[] {
  const indent = Math.max(lineWidth(first), lineWidth(rest));
  return wrap(content, width - indent).map((l, i) => [...(i === 0 ? first : rest), ...l]);
}

/** Cuts a line to `width` columns, ending with "…" when something was cut. Newlines become spaces. */
export function truncate(line: Line, width: number): Line {
  const clean = line.map((s) => ({ text: flat(s.text), style: s.style }));
  if (lineWidth(clean) <= width) return clean;
  const out: Line = [];
  let used = 0;
  for (const span of clean) {
    let text = "";
    for (const g of graphemes(span.text)) {
      const w = graphemeWidth(g);
      if (used + w > width - 1) {
        if (text) out.push({ text, style: span.style });
        out.push({ text: "…", style: span.style });
        return out;
      }
      text += g;
      used += w;
    }
    if (text) out.push({ text, style: span.style });
  }
  return out;
}

/** Pads a line with spaces to exactly `width` columns (after truncating if needed). */
export function fit(line: Line, width: number): Line {
  const cut = truncate(line, width);
  const pad = width - lineWidth(cut);
  return pad > 0 ? [...cut, { text: " ".repeat(pad) }] : cut;
}
