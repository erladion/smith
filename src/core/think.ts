import type { BlockKind } from "./events.js";

const OPEN = "<think>";
const CLOSE = "</think>";

export interface Segment {
  kind: BlockKind;
  text: string;
}

/**
 * Splits streamed content into text and reasoning for servers that leave
 * `<think>...</think>` inline instead of sending a separate reasoning field.
 * Tags may be split across chunks, so a trailing partial tag is held back
 * until the next chunk shows whether it really is a tag.
 */
export class ThinkTagParser {
  private inThink = false;
  private pending = "";

  push(chunk: string): Segment[] {
    let buf = this.pending + chunk;
    this.pending = "";
    const out: Segment[] = [];

    for (;;) {
      const tag = this.inThink ? CLOSE : OPEN;
      const at = buf.indexOf(tag);
      // A stray closing tag outside a think block (templates that open the
      // block in the prompt) is dropped rather than shown as text.
      const stray = this.inThink ? -1 : buf.indexOf(CLOSE);
      if (stray !== -1 && (at === -1 || stray < at)) {
        this.emit(out, buf.slice(0, stray));
        buf = buf.slice(stray + CLOSE.length);
        continue;
      }
      if (at === -1) break;
      this.emit(out, buf.slice(0, at));
      buf = buf.slice(at + tag.length);
      this.inThink = !this.inThink;
    }

    const keep = partialTagSuffix(buf, this.inThink ? [CLOSE] : [OPEN, CLOSE]);
    this.emit(out, buf.slice(0, buf.length - keep));
    this.pending = buf.slice(buf.length - keep);
    return out;
  }

  /** Releases any held-back text at the end of the stream. */
  flush(): Segment[] {
    const out: Segment[] = [];
    this.emit(out, this.pending);
    this.pending = "";
    return out;
  }

  private emit(out: Segment[], text: string): void {
    if (text) out.push({ kind: this.inThink ? "reasoning" : "text", text });
  }
}

/** Length of the longest suffix of `buf` that is a proper prefix of one of the tags. */
function partialTagSuffix(buf: string, tags: string[]): number {
  let best = 0;
  for (const tag of tags) {
    for (let n = Math.min(tag.length - 1, buf.length); n > best; n--) {
      if (buf.endsWith(tag.slice(0, n))) {
        best = n;
        break;
      }
    }
  }
  return best;
}

/** Removes complete think blocks from a finished, non-streamed response. */
export function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/^[\s\S]*?<\/think>/, "").trim();
}
