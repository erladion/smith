import type { Key } from "../tui/keys.js";
import type { Line } from "../tui/style.js";
import { truncate } from "../tui/text.js";
import { type CompletionContext, type Suggestion, suggest } from "./commands.js";
import { DIM } from "./entries.js";

const MAX_SHOWN = 8;

/**
 * The command suggestions under the input box: which one is highlighted,
 * whether esc hid them, and the keys that act on them.
 */
export class SuggestionList {
  private index = 0;
  /** The input they were hidden for with esc; they come back once it changes. */
  private dismissedFor: string | null = null;
  /** Model ids the server listed, for completing /model. */
  models: string[] = [];

  /** Suggestions for the input, unless hidden for it. */
  items(input: string, ctx: Omit<CompletionContext, "models">): Suggestion[] {
    if (input === this.dismissedFor) return [];
    return suggest(input, { ...ctx, models: this.models });
  }

  /** The input changed: start again from the first suggestion. */
  reset(): void {
    this.index = 0;
  }

  /**
   * Arrows move the highlight, tab fills in the highlighted suggestion, esc
   * hides them. Returns the text to run for enter, "handled" for keys used
   * here, or null for keys the editor should get.
   */
  handle(key: Key, items: Suggestion[], input: string, setInput: (value: string) => void): { run: string } | "handled" | null {
    if (items.length === 0 || key.ctrl || key.meta || key.shift) return null;
    const at = Math.min(this.index, items.length - 1);
    switch (key.name) {
      case "up":
      case "down":
        this.index = (at + (key.name === "up" ? items.length - 1 : 1)) % items.length;
        return "handled";
      case "tab": {
        // A command that takes an argument gets a space, so its completions show.
        const chosen = items[at]!;
        const takesArgs = !chosen.text.includes(" ") && /[[|]/.test(chosen.label);
        setInput(chosen.text + (takesArgs ? " " : ""));
        this.index = 0;
        return "handled";
      }
      case "return":
        return { run: items[at]!.text };
      case "escape":
        this.dismissedFor = input;
        return "handled";
      default:
        return null;
    }
  }

  lines(items: Suggestion[], width: number): Line[] {
    if (items.length === 0) return [];
    const at = Math.min(this.index, items.length - 1);
    const start = Math.min(Math.max(0, at - Math.floor(MAX_SHOWN / 2)), Math.max(0, items.length - MAX_SHOWN));
    const labelWidth = Math.min(28, Math.max(...items.map((i) => i.label.length)));
    const lines = items.slice(start, start + MAX_SHOWN).map((item, i): Line => {
      const selected = start + i === at;
      return truncate(
        [
          { text: selected ? " › " : "   ", style: { color: "cyan" } },
          { text: item.label.padEnd(labelWidth), style: selected ? { color: "cyan", bold: true } : undefined },
          { text: item.hint ? `  ${item.hint}` : "", style: DIM },
        ],
        width,
      );
    });
    const more = items.length - (start + MAX_SHOWN);
    lines.push([{ text: `   ${more > 0 ? `${more} more · ` : ""}tab completes · enter runs · esc hides`, style: DIM }]);
    return lines;
  }
}
