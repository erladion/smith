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

  constructor(
    readonly title: string,
    readonly items: PickerItem[],
    readonly current?: string,
    private readonly options: {
      /** Chosen when backspace is pressed with nothing typed (e.g. "go up" in a folder browser). */
      back?: string;
      /** Replaces the default key help line. */
      help?: string;
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

  /** Applies a key: returns the chosen value, "cancel", or undefined to keep going. */
  handle(key: Key): { value: string } | "cancel" | undefined {
    const visible = this.visible();
    const at = this.selected();
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

    const out: Line[] = [
      [{ text: this.title, style: { bold: true } }],
      [{ text: this.filter ? `filter: ${this.filter}` : (this.options.help ?? "type to filter · ↑↓ move · enter select · esc cancel"), style: { dim: true } }],
    ];
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
