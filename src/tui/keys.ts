export type KeyName =
  | "text"
  | "paste"
  | "char"
  | "return"
  | "backspace"
  | "delete"
  | "tab"
  | "escape"
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown";

export interface Key {
  name: KeyName;
  /** For "text" (typed characters), "paste", and "char" (a letter with ctrl or alt). */
  text?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/**
 * Turns raw terminal input into keys. Handles arrow and editing keys in the
 * common xterm encodings, ctrl and alt combinations, bracketed paste (which
 * may arrive split across several reads), and the kitty keyboard protocol's
 * `CSI code;modifiers u` form, which is how terminals report Shift+Enter.
 */
export class KeyReader {
  private paste: string | null = null;

  feed(data: string): Key[] {
    const keys: Key[] = [];
    let i = 0;
    while (i < data.length) {
      if (this.paste !== null) {
        const end = data.indexOf(PASTE_END, i);
        if (end === -1) {
          this.paste += data.slice(i);
          break;
        }
        keys.push({ name: "paste", text: this.paste + data.slice(i, end) });
        this.paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      if (data.startsWith(PASTE_START, i)) {
        this.paste = "";
        i += PASTE_START.length;
        continue;
      }

      const ch = data[i]!;
      if (ch === "\x1b") {
        const rest = data.slice(i);
        const seq = /^\x1b\[([0-9;:]*)([A-Za-z~])/.exec(rest) ?? /^\x1bO()([A-Za-z])/.exec(rest);
        if (seq) {
          const key = escapeKey(seq[1]!, seq[2]!);
          if (key) keys.push(key);
          i += seq[0].length;
        } else if (rest.length === 1 || rest[1] === "\x1b") {
          keys.push({ name: "escape" });
          i += 1;
        } else {
          const next = rest[1]!;
          if (next === "\x7f" || next === "\b") keys.push({ name: "backspace", meta: true });
          else if (next === "\r") keys.push({ name: "return", meta: true });
          else keys.push({ name: "char", text: next, meta: true });
          i += 2;
        }
        continue;
      }
      if (ch === "\r") keys.push({ name: "return" });
      // In raw mode Enter sends CR; LF only comes from Ctrl+J.
      else if (ch === "\n") keys.push({ name: "return", ctrl: true });
      else if (ch === "\x7f" || ch === "\b") keys.push({ name: "backspace" });
      else if (ch === "\t") keys.push({ name: "tab" });
      else if (ch.charCodeAt(0) < 0x20) keys.push({ name: "char", text: String.fromCharCode(ch.charCodeAt(0) + 96), ctrl: true });
      else {
        let j = i;
        while (j < data.length && data.charCodeAt(j) >= 0x20 && data[j] !== "\x7f") j++;
        keys.push({ name: "text", text: data.slice(i, j) });
        i = j;
        continue;
      }
      i += 1;
    }
    return keys;
  }
}

const FINAL: Record<string, KeyName> = { A: "up", B: "down", C: "right", D: "left", H: "home", F: "end" };
const TILDE: Record<string, KeyName> = { "1": "home", "7": "home", "4": "end", "8": "end", "3": "delete", "5": "pageup", "6": "pagedown" };

// Unicode code points the kitty protocol uses for keys that aren't characters.
const KITTY: Record<number, KeyName> = { 13: "return", 57414: "return", 27: "escape", 9: "tab", 127: "backspace", 8: "backspace" };

function escapeKey(params: string, final: string): Key | null {
  const [first = "", modifier = ""] = params.split(";");
  // Fields may carry ":"-separated extras (alternate keys, event types); only the first part matters here.
  const bits = Math.max(0, (parseInt(modifier.split(":")[0]!, 10) || 1) - 1);
  const mods = { shift: (bits & 1) !== 0, meta: (bits & 2) !== 0, ctrl: (bits & 4) !== 0 };
  if (final === "u") {
    const code = parseInt(first.split(":")[0]!, 10);
    if (Number.isNaN(code)) return null;
    const named = KITTY[code];
    if (named) return { name: named, ...mods };
    const text = String.fromCodePoint(code);
    return mods.ctrl || mods.meta ? { name: "char", text, ...mods } : { name: "text", text: mods.shift ? text.toUpperCase() : text };
  }
  if (final === "Z") return { name: "tab", shift: true };
  const name = final === "~" ? TILDE[first] : FINAL[final];
  return name ? { name, ...mods } : null;
}
