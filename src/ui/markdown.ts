import type { Line, Span, Style } from "./style.js";
import { prefixed, wrap } from "./text.js";

/**
 * Renders the Markdown that models commonly write: **bold**, *italic*,
 * `code`, headings, bullet and numbered lists, quotes, rules, fenced code
 * blocks and links. Anything else shows as plain text.
 */
export function markdownLines(text: string, width: number): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  const gutter: Line = [{ text: "│ ", style: { dim: true } }];

  for (const raw of text.split("\n")) {
    const fenceMark = /^\s*(`{3,}|~{3,})/.exec(raw)?.[1];
    if (fence) {
      if (fenceMark && fenceMark[0] === fence[0] && fenceMark.length >= fence.length) fence = null;
      else out.push(...prefixed(gutter, gutter, [{ text: raw }], width));
      continue;
    }
    if (fenceMark) {
      fence = fenceMark;
      continue;
    }
    if (!raw.trim()) {
      out.push([]);
      continue;
    }

    let m: RegExpExecArray | null;
    if ((m = /^(#{1,6})\s+(.*)$/.exec(raw))) {
      const style: Style = m[1]!.length <= 2 ? { bold: true, color: "cyan" } : { bold: true };
      out.push(...wrap(inline(m[2]!, style), width));
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) {
      out.push([{ text: "─".repeat(Math.min(width, 40)), style: { dim: true } }]);
    } else if ((m = /^\s*>\s?(.*)$/.exec(raw))) {
      const bar: Line = [{ text: "│ ", style: { dim: true } }];
      out.push(...prefixed(bar, bar, inline(m[1]!, { italic: true, dim: true }), width));
    } else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(raw))) {
      const indent = " ".repeat(Math.floor(m[1]!.length / 2) * 2);
      out.push(...prefixed([{ text: `${indent}• ` }], [{ text: `${indent}  ` }], inline(m[2]!), width));
    } else if ((m = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(raw))) {
      const indent = " ".repeat(Math.floor(m[1]!.length / 2) * 2);
      const marker = `${indent}${m[2]}. `;
      out.push(...prefixed([{ text: marker }], [{ text: " ".repeat(marker.length) }], inline(m[3]!), width));
    } else {
      out.push(...wrap(inline(raw), width));
    }
  }
  return out;
}

const INLINE =
  /(`+)(.+?)\1|\*\*(.+?)\*\*|__(.+?)__|(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])|(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Inline Markdown in one line of text, on top of an optional base style. */
export function inline(text: string, base?: Style): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), style: base });
    if (m[1]) out.push({ text: m[2]!, style: { ...base, color: "cyan" } });
    else if (m[3] ?? m[4]) out.push({ text: (m[3] ?? m[4])!, style: { ...base, bold: true } });
    else if (m[5] ?? m[6]) out.push({ text: (m[5] ?? m[6])!, style: { ...base, italic: true } });
    else if (m[7]) {
      out.push({ text: m[7], style: { ...base, underline: true } });
      if (m[8] !== m[7]) out.push({ text: ` (${m[8]})`, style: { ...base, dim: true } });
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), style: base });
  return out;
}

/**
 * Where streamed Markdown can be split so the first part can be printed for
 * good: the last blank line that isn't inside a code block. -1 if none.
 */
export function safeSplit(text: string): number {
  let at = text.lastIndexOf("\n\n");
  while (at > 0) {
    const fences = text.slice(0, at).match(/^\s*(`{3,}|~{3,})/gm)?.length ?? 0;
    if (fences % 2 === 0) return at;
    at = text.lastIndexOf("\n\n", at - 1);
  }
  return -1;
}
