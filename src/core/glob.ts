/**
 * Minimal glob matching, so file search doesn't depend on Node's newer
 * fs.glob. Supports `*`, `?`, `**`, `{a,b}` and `[abc]`/`[!abc]`, matched
 * against slash-separated paths relative to the search directory.
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${toSource(pattern)}$`);
}

function toSource(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    const atSegmentStart = i === 0 || pattern[i - 1] === "/";

    if (c === "*" && pattern[i + 1] === "*" && atSegmentStart) {
      if (pattern[i + 2] === "/") {
        out += "(?:[^/]*/)*"; // "**/": zero or more directories
        i += 2;
        continue;
      }
      if (i + 2 === pattern.length) {
        out += ".*"; // trailing "**": everything below
        i += 1;
        continue;
      }
    }
    if (c === "*") {
      out += "[^/]*";
      while (pattern[i + 1] === "*") i++;
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end === -1) {
        out += "\\{";
        continue;
      }
      const alternatives = pattern.slice(i + 1, end).split(",");
      out += `(?:${alternatives.map(toSource).join("|")})`;
      i = end;
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      let set = pattern.slice(i + 1, end).replace(/\\/g, "\\\\");
      if (set.startsWith("!")) set = `^${set.slice(1)}`;
      out += `[${set}]`;
      i = end;
    } else {
      out += c.replace(/[.+^$()|\\\]]/g, "\\$&");
    }
  }
  return out;
}
