import type { Key } from "./keys.js";
import type { Line } from "./style.js";
import { graphemes } from "./text.js";

/**
 * The prompt's input. Enter submits; pasted text keeps its newlines.
 *
 *   shift+enter, alt+enter, ctrl+j  new line
 *   \ then enter                    new line (the backslash is removed)
 *   ←/→, ctrl+←/→ (or alt+b/f)   move by character / word
 *   home/end (or ctrl+a/e)        start / end
 *   backspace, delete             delete a character
 *   ctrl+w (or alt+backspace)     delete the previous word
 *   ctrl+u / ctrl+k               delete to the start / end
 *   ↑/↓                           earlier / later inputs
 */
export class LineEditor {
  value = "";
  /** Index into `value` (UTF-16 units), always on a grapheme boundary. */
  cursor = 0;
  private history: string[] = [];
  /** Position while browsing history; history.length means "the line being typed". */
  private browsing = 0;
  private draft = "";

  /** Applies a key. Returns "submit" when Enter was pressed. */
  handle(key: Key): "submit" | undefined {
    const { name, ctrl, meta } = key;
    const letter = name === "char" ? key.text : undefined;

    if (name === "return") {
      if (key.shift || key.meta || key.ctrl) {
        this.insert("\n");
      } else if (this.value[this.cursor - 1] === "\\") {
        // Line continuation, as in a shell: the backslash becomes the line break.
        this.deleteTo(this.cursor - 1);
        this.insert("\n");
      } else {
        return "submit";
      }
      return undefined;
    }
    if (name === "text" || name === "paste") this.insert(key.text ?? "");
    else if (name === "left" && (ctrl || meta)) this.cursor = this.wordStart();
    else if (name === "right" && (ctrl || meta)) this.cursor = this.wordEnd();
    else if (name === "left") this.cursor = this.prevBoundary();
    else if (name === "right") this.cursor = this.nextBoundary();
    else if (name === "home" || (ctrl && letter === "a")) this.cursor = 0;
    else if (name === "end" || (ctrl && letter === "e")) this.cursor = this.value.length;
    else if (meta && letter === "b") this.cursor = this.wordStart();
    else if (meta && letter === "f") this.cursor = this.wordEnd();
    else if (name === "backspace" && meta) this.deleteTo(this.wordStart());
    else if (name === "backspace") this.deleteTo(this.prevBoundary());
    else if (name === "delete") this.deleteTo(this.nextBoundary());
    else if (ctrl && letter === "w") this.deleteTo(this.wordStart());
    else if (ctrl && letter === "u") this.deleteTo(0);
    else if (ctrl && letter === "k") this.deleteTo(this.value.length);
    else if (name === "up") this.recall(-1);
    else if (name === "down") this.recall(1);
    return undefined;
  }

  /** Clears the line and remembers it for ↑. */
  commit(): string {
    const text = this.value;
    if (text.trim() && this.history[this.history.length - 1] !== text) this.history.push(text);
    this.browsing = this.history.length;
    this.draft = "";
    this.set("");
    return text;
  }

  /** The line with a block cursor, or the placeholder when empty. */
  render(placeholder: string): Line {
    const cursorStyle = { inverse: true };
    if (!this.value) return [{ text: " ", style: cursorStyle }, { text: placeholder, style: { dim: true } }];
    const at = this.value.slice(this.cursor, this.nextBoundary());
    const under = !at || at === "\n" ? " " : at;
    return [
      { text: this.value.slice(0, this.cursor) },
      { text: under, style: cursorStyle },
      { text: (at === "\n" ? "\n" : "") + this.value.slice(this.cursor + at.length) },
    ];
  }

  private set(value: string): void {
    this.value = value;
    this.cursor = value.length;
  }

  private insert(text: string): void {
    const clean = text.replace(/\r\n?/g, "\n");
    this.value = this.value.slice(0, this.cursor) + clean + this.value.slice(this.cursor);
    this.cursor += clean.length;
  }

  private deleteTo(target: number): void {
    const [from, to] = target < this.cursor ? [target, this.cursor] : [this.cursor, target];
    this.value = this.value.slice(0, from) + this.value.slice(to);
    this.cursor = from;
  }

  private recall(direction: -1 | 1): void {
    const next = this.browsing + direction;
    if (next < 0 || next > this.history.length) return;
    if (this.browsing === this.history.length) this.draft = this.value;
    this.browsing = next;
    this.set(next === this.history.length ? this.draft : this.history[next]!);
  }

  private prevBoundary(): number {
    const before = graphemes(this.value.slice(0, this.cursor));
    return this.cursor - (before[before.length - 1]?.length ?? 0);
  }

  private nextBoundary(): number {
    const first = graphemes(this.value.slice(this.cursor))[0];
    return this.cursor + (first?.length ?? 0);
  }

  private wordStart(): number {
    const before = this.value.slice(0, this.cursor);
    return before.replace(/\S+\s*$|\s+$/, "").length;
  }

  private wordEnd(): number {
    const after = this.value.slice(this.cursor);
    return this.cursor + (/^\s*\S+|^\s+/.exec(after)?.[0].length ?? 0);
  }
}
