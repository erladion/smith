import type { Key } from "./keys.js";
import type { Line } from "./style.js";

export interface PickerItem {
  value: string;
  label: string;
  hint?: string;
}

const WINDOW = 10;

/** A list moved through with ↑/↓ and narrowed down by typing. */
export class Picker {
  private filter = "";
  private index: number;
  /** The item waiting for y/n on the action, and the question. */
  private confirming: { item: PickerItem; question: string } | null = null;
  /** Why the action couldn't be done, shown until the next key. */
  private refusal: string | null = null;

  constructor(
    readonly title: string,
    readonly items: PickerItem[],
    readonly current?: string,
    private readonly options: {
      /** Chosen when backspace is pressed with nothing typed (e.g. "go up" in a folder browser). */
      back?: string;
      /** Replaces the default key help line. */
      help?: string;
      /**
       * A second thing to do with an item, on ctrl+<key> (e.g. delete it).
       * `check` returns the question to confirm with y/n, or why it can't be done.
       */
      action?: { key: string; hint: string; check: (item: PickerItem) => { ask: string } | { refuse: string } };
    } = {},
  ) {
    this.index = Math.max(0, items.findIndex((i) => i.value === current));
  }

  private visible(): PickerItem[] {
    const needle = this.filter.toLowerCase();
    return needle ? this.items.filter((i) => i.label.toLowerCase().includes(needle)) : this.items;
  }

  private selected(): number {
    return Math.min(this.index, Math.max(0, this.visible().length - 1));
  }

  /**
   * Applies a key: returns the chosen value (with `action` when it was the
   * action, confirmed), "cancel", or undefined to keep going.
   */
  handle(key: Key): { value: string; action?: boolean } | "cancel" | undefined {
    const visible = this.visible();
    const at = this.selected();
    this.refusal = null;
    if (this.confirming) {
      const { item } = this.confirming;
      this.confirming = null;
      return key.name === "text" && key.text?.toLowerCase() === "y" ? { value: item.value, action: true } : undefined;
    }
    const action = this.options.action;
    if (action && key.name === "char" && key.ctrl && key.text === action.key) {
      const item = visible[at];
      if (!item) return undefined;
      const check = action.check(item);
      if ("ask" in check) this.confirming = { item, question: check.ask };
      else this.refusal = check.refuse;
      return undefined;
    }
    if (key.name === "escape") return "cancel";
    if (key.name === "return") {
      const item = visible[at];
      return item ? { value: item.value } : undefined;
    }
    if (key.name === "up") this.index = at === 0 ? visible.length - 1 : at - 1;
    else if (key.name === "down") this.index = at >= visible.length - 1 ? 0 : at + 1;
    else if (key.name === "backspace") {
      if (!this.filter && this.options.back) return { value: this.options.back };
      this.filter = this.filter.slice(0, -1);
      this.index = 0;
    } else if (key.name === "text" || key.name === "paste") {
      this.filter += (key.text ?? "").replace(/\s+/g, " ");
      this.index = 0;
    }
    return undefined;
  }

  /** Content lines (without the surrounding box). */
  lines(): Line[] {
    const visible = this.visible();
    const at = this.selected();
    const start = Math.min(Math.max(0, at - Math.floor(WINDOW / 2)), Math.max(0, visible.length - WINDOW));
    const shown = visible.slice(start, start + WINDOW);

    const action = this.options.action;
    const help = this.options.help ?? `type to filter · ↑↓ move · enter select${action ? ` · ctrl+${action.key} ${action.hint}` : ""} · esc cancel`;
    const second: Line = this.confirming
      ? [{ text: `${this.confirming.question} `, style: { color: "yellow", bold: true } }, { text: "y", style: { color: "green" } }, { text: "/n", style: { dim: true } }]
      : this.refusal
        ? [{ text: this.refusal, style: { color: "yellow" } }]
        : [{ text: this.filter ? `filter: ${this.filter}` : help, style: { dim: true } }];
    const out: Line[] = [[{ text: this.title, style: { bold: true } }], second];
    if (start > 0) out.push([{ text: `  ↑ ${start} more`, style: { dim: true } }]);
    shown.forEach((item, i) => {
      const selected = start + i === at;
      const line: Line = [
        { text: selected ? "› " : "  ", style: selected ? { color: "cyan" } : undefined },
        { text: item.label, style: selected ? { color: "cyan", bold: true } : undefined },
      ];
      if (item.value === this.current) line.push({ text: " (current)", style: { color: "green" } });
      if (item.hint) line.push({ text: `  ${item.hint}`, style: { dim: true } });
      out.push(line);
    });
    if (visible.length === 0) out.push([{ text: "  no matches", style: { dim: true } }]);
    const below = visible.length - start - WINDOW;
    if (below > 0) out.push([{ text: `  ↓ ${below} more`, style: { dim: true } }]);
    return out;
  }
}
