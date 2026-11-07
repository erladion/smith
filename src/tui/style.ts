import { sanitize } from "./text.js";

export type Color = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white" | "gray";

export interface Style {
  color?: Color;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

/** A run of text in one style. Text is plain: styling lives only in `style`. */
export interface Span {
  text: string;
  style?: Style;
}

/** One screen line. */
export type Line = Span[];

// The 16 basic colors, so the terminal's own theme decides the actual shades.
const COLOR_CODES: Record<Color, number> = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  white: 37,
  gray: 90,
};

let colors = !process.env.NO_COLOR;

/** Turns colors off (NO_COLOR); bold, dim, italic and inverse stay. */
export function setColors(enabled: boolean): void {
  colors = enabled;
}

export function colorsEnabled(): boolean {
  return colors;
}

function sgr(style: Style | undefined): string {
  if (!style) return "";
  const codes: number[] = [];
  if (style.bold) codes.push(1);
  if (style.dim) codes.push(2);
  if (style.italic) codes.push(3);
  if (style.underline) codes.push(4);
  if (style.inverse) codes.push(7);
  if (style.color && colors) codes.push(COLOR_CODES[style.color]);
  return codes.length ? `\x1b[${codes.join(";")}m` : "";
}

/** Renders a line as terminal output. Span text is sanitized, so it can't inject escape codes. */
export function toAnsi(line: Line): string {
  let out = "";
  for (const span of line) {
    const text = sanitize(span.text).replace(/\n/g, " ");
    const open = sgr(span.style);
    out += open ? `${open}${text}\x1b[0m` : text;
  }
  return out;
}
