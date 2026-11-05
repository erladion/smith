import { type Line, toAnsi } from "./style.js";

export interface Screen {
  write(data: string): unknown;
  readonly columns: number;
  readonly rows: number;
}

// Terminals that support it show a frame only once it is fully drawn; others ignore these.
const BEGIN_FRAME = "\x1b[?2026h";
const END_FRAME = "\x1b[?2026l";

/**
 * Inline rendering: finished output is printed once and scrolls into the
 * terminal's normal scrollback, and only a small "live" region at the bottom
 * (input, spinner, prompts, status) is erased and redrawn.
 *
 * The cursor always rests at the end of the live region's last line, so
 * erasing it means: go to column 0, up (rows - 1) lines, clear to the end.
 */
export class InlineRenderer {
  private liveRows = 0;
  private lastFrame = "";
  private pending: Line[] = [];

  constructor(private readonly screen: Screen) {}

  /** Queues lines to print above the live region on the next draw. */
  print(lines: Line[]): void {
    this.pending.push(...lines);
  }

  /** Prints queued lines and replaces the live region with `live`. */
  draw(live: Line[]): void {
    // A live region taller than the screen can't be erased (the cursor can't
    // move above the top), so keep only the bottom of it.
    const maxRows = Math.max(1, (this.screen.rows || 24) - 1);
    const shown = live.length > maxRows ? live.slice(live.length - maxRows) : live;

    const frame = shown.map(toAnsi).join("\r\n");
    // Nothing new to print and the live region is unchanged: skip the redraw.
    if (this.pending.length === 0 && frame === this.lastFrame && this.liveRows === shown.length) return;

    let out = BEGIN_FRAME + this.eraseLive();
    for (const line of this.pending) out += `${toAnsi(line)}\r\n`;
    this.pending = [];
    out += frame + END_FRAME;

    this.lastFrame = frame;
    this.liveRows = shown.length;
    this.screen.write(out);
  }

  /**
   * Clears the screen and scrollback and starts over at the top. Used when
   * the width changes: terminals differ in whether they re-wrap old lines,
   * so instead of guessing, the caller reprints everything at the new width.
   */
  reset(): void {
    this.screen.write("\x1b[H\x1b[2J\x1b[3J");
    this.liveRows = 0;
    this.lastFrame = "";
    this.pending = [];
  }

  /** Erases the live region and prints anything queued, leaving the cursor on a fresh line. */
  finish(): void {
    this.draw([]);
  }

  private eraseLive(): string {
    if (this.liveRows === 0) return "";
    return `\r${this.liveRows > 1 ? `\x1b[${this.liveRows - 1}A` : ""}\x1b[J`;
  }
}
