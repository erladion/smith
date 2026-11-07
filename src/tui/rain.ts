import type { Line, Style } from "./style.js";

/**
 * Digital rain: green glyphs falling down the screen, with a title that
 * locks into place where the drops pass through it.
 *
 * `Rain` is the simulation (one step per frame, drawn to a string or to
 * lines); `playRain` runs it full-screen on the terminal's alternate screen,
 * so the normal screen and its scrollback are left as they were.
 */

// Half-width katakana (one column wide), digits and a few symbols.
const GLYPHS = [..."ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:.=*+-<>¦"];

// The 16 basic colors, so the terminal's theme picks the shades.
const HEAD = "\x1b[1;97m";
const BRIGHT = "\x1b[92m";
const GREEN = "\x1b[32m";
const FADED = "\x1b[2;32m";
const TITLE = "\x1b[1;92m";
const RESET = "\x1b[0m";

type Shade = "head" | "bright" | "green" | "faded" | "title";
const ANSI: Record<Shade, string> = { head: HEAD, bright: BRIGHT, green: GREEN, faded: FADED, title: TITLE };
const STYLES: Record<Shade, Style> = {
  head: { color: "white", bold: true },
  bright: { color: "green", bold: true },
  green: { color: "green" },
  faded: { color: "green", dim: true },
  title: { color: "green", bold: true },
};

interface Drop {
  /** Row of the leading glyph; negative while it's still above the screen. */
  head: number;
  /** Rows per frame. */
  speed: number;
  /** Rows of trail behind the head. */
  length: number;
}

export interface RainOptions {
  /** Text that locks into the middle row as drops pass; "" for none. */
  title: string;
  /** Frames of falling rain before the title is complete; Infinity rains until stopped. */
  frames?: number;
  /** Frames to keep showing the finished title. */
  holdFrames?: number;
  /** For tests: a seeded source of randomness. */
  random?: () => number;
}

export class Rain {
  private readonly glyphs: string[][];
  private readonly drops: (Drop | null)[];
  private readonly title: string[];
  private readonly titleRow: number;
  private readonly titleCol: number;
  private readonly locked: boolean[];
  private readonly frames: number;
  private readonly holdFrames: number;
  private readonly random: () => number;
  private frame = 0;

  constructor(
    readonly cols: number,
    readonly rows: number,
    opts: RainOptions,
  ) {
    this.random = opts.random ?? Math.random;
    this.frames = opts.frames ?? 36;
    this.holdFrames = opts.holdFrames ?? 12;
    this.title = [...opts.title.slice(0, cols)];
    this.titleRow = Math.floor(rows / 2);
    this.titleCol = Math.floor((cols - this.title.length) / 2);
    this.locked = this.title.map(() => false);
    this.glyphs = Array.from({ length: rows }, () => Array.from({ length: cols }, () => this.glyph()));
    // Drops start at staggered heights above the screen, so they don't arrive as one line.
    this.drops = Array.from({ length: cols }, () => (this.random() < 0.85 ? this.drop(rows * 0.9) : null));
  }

  /** Whether the animation is over: the title is complete and has been shown for a moment. */
  get done(): boolean {
    return this.frame >= this.frames + this.holdFrames;
  }

  /** The title as shown so far, with spaces for letters not locked in yet. */
  get shownTitle(): string {
    return this.title.map((ch, i) => (this.locked[i] ? ch : " ")).join("");
  }

  step(): void {
    this.frame++;
    const spawning = this.frame < this.frames * 0.6;
    const revealing = this.frame >= this.frames * 0.3;
    for (let c = 0; c < this.cols; c++) {
      const drop = this.drops[c];
      if (!drop) {
        if (spawning && this.random() < 0.04) this.drops[c] = this.drop(this.rows * 0.3);
        continue;
      }
      const before = drop.head;
      drop.head += drop.speed;
      // A drop passing through the title row leaves its letter behind.
      const t = c - this.titleCol;
      if (revealing && t >= 0 && t < this.title.length && before <= this.titleRow && drop.head >= this.titleRow) this.locked[t] = true;
      if (drop.head - drop.length > this.rows) this.drops[c] = spawning ? this.drop(this.rows * 0.3) : null;
    }
    if (this.frame >= this.frames) this.locked.fill(true);
    // Glyphs flicker.
    const changes = Math.ceil(this.rows * this.cols * 0.03);
    for (let i = 0; i < changes; i++) {
      this.glyphs[Math.floor(this.random() * this.rows)]![Math.floor(this.random() * this.cols)] = this.glyph();
    }
  }

  /** The whole screen, row by row from the top-left corner. */
  render(): string {
    let out = "";
    for (let r = 0; r < this.rows; r++) {
      out += `\x1b[${r + 1};1H`;
      let current = "";
      for (let c = 0; c < this.cols; c++) {
        const [shade, ch] = this.cell(r, c);
        const style = shade ? ANSI[shade] : "";
        if (style !== current) {
          out += RESET + style;
          current = style;
        }
        out += ch;
      }
      out += RESET;
    }
    return out;
  }

  /** The rain as styled lines, for drawing it inside other output (e.g. a status area). */
  lines(): Line[] {
    const lines: Line[] = [];
    for (let r = 0; r < this.rows; r++) {
      const line: Line = [];
      let shade: Shade | null | undefined;
      for (let c = 0; c < this.cols; c++) {
        const [s, ch] = this.cell(r, c);
        if (s === shade && line.length > 0) line[line.length - 1]!.text += ch;
        else line.push({ text: ch, style: s ? STYLES[s] : undefined });
        shade = s;
      }
      lines.push(line);
    }
    return lines;
  }

  private cell(r: number, c: number): [Shade | null, string] {
    const t = c - this.titleCol;
    if (r === this.titleRow && t >= 0 && t < this.title.length && this.locked[t]) return ["title", this.title[t]!];
    const drop = this.drops[c];
    const d = drop ? drop.head - r : -1;
    if (!drop || d < 0 || d >= drop.length) return [null, " "];
    const glyph = this.glyphs[r]![c]!;
    if (d < 1) return ["head", glyph];
    if (d < 3) return ["bright", glyph];
    return [d < drop.length * 0.5 ? "green" : "faded", glyph];
  }

  private drop(spread: number): Drop {
    return {
      // At least a few rows of gap above, so short strips aren't solid green.
      head: -this.random() * Math.max(spread, 4),
      speed: this.rows / (10 + this.random() * 16),
      length: Math.max(4, Math.round(this.rows * (0.3 + this.random() * 0.5))),
    };
  }

  private glyph(): string {
    return GLYPHS[Math.floor(this.random() * GLYPHS.length)]!;
  }
}

/**
 * `width` columns of a scrolling stream of glyphs with gaps, like code
 * going by: each step of `offset` moves it one column to the left.
 */
export function codeStream(offset: number, width: number): string {
  let out = "";
  for (let i = 0; i < width; i++) {
    let h = Math.imul(offset + i, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = (h ^ (h >>> 13)) >>> 0;
    out += h % 5 === 0 ? " " : GLYPHS[h % GLYPHS.length]!;
  }
  return out;
}

export interface RainTerminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

const FRAME_MS = 33;

/**
 * Plays the rain full-screen. Any key, or resizing the window, ends it early.
 * Does nothing on a terminal too small for it. The input should already be
 * in raw mode, so a key press arrives without enter; it's used up skipping.
 */
export function playRain(term: RainTerminal, opts: RainOptions): Promise<void> {
  const { input, output } = term;
  const cols = output.columns || 0;
  const rows = output.rows || 0;
  if (!output.isTTY || cols < 30 || rows < 10) return Promise.resolve();

  const rain = new Rain(cols, rows, opts);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    // Leave the alternate screen however this ends, even if the process exits mid-animation.
    const restore = () => output.write(`${RESET}\x1b[?1049l`);
    const finish = () => {
      clearInterval(timer);
      input.removeListener("data", finish);
      output.removeListener("resize", finish);
      process.removeListener("exit", restore);
      restore();
      resolve();
    };
    process.once("exit", restore);
    input.on("data", finish);
    input.resume();
    output.on("resize", finish);
    output.write("\x1b[?1049h\x1b[?25l\x1b[2J");
    timer = setInterval(() => {
      rain.step();
      output.write(`\x1b[?2026h${rain.render()}\x1b[?2026l`);
      if (rain.done) finish();
    }, FRAME_MS);
  });
}
