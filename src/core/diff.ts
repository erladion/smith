/** A line in a diff, with its line number in the old or new file. */
export type DiffLine =
  | { kind: "context"; text: string; oldLine: number; newLine: number }
  | { kind: "remove"; text: string; oldLine: number }
  | { kind: "add"; text: string; newLine: number }
  /** Unchanged lines left out between hunks. */
  | { kind: "gap"; count: number };

// Above this many changed lines on each side, skip the exact diff and show a
// plain replacement. Keeps memory bounded on huge rewrites.
const MAX_MYERS_LINES = 4000;

/**
 * Line diff between two texts, as hunks with `context` unchanged lines around
 * each change (Myers' algorithm, like git's default).
 */
export function diffLines(before: string, after: string, context = 2): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);

  // Common prefix and suffix are cheap to find and usually most of the file.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const middleA = a.slice(start, endA);
  const middleB = b.slice(start, endB);
  const ops =
    middleA.length > MAX_MYERS_LINES || middleB.length > MAX_MYERS_LINES
      ? [...middleA.map(() => "-" as const), ...middleB.map(() => "+" as const)]
      : myers(middleA, middleB);

  // Full list of lines with numbers, then keep only changes and their context.
  const all: DiffLine[] = [];
  let x = 0;
  let y = 0;
  for (; x < start; x++, y++) all.push({ kind: "context", text: a[x]!, oldLine: x + 1, newLine: y + 1 });
  for (const op of ops) {
    if (op === "=") {
      all.push({ kind: "context", text: a[x]!, oldLine: x + 1, newLine: y + 1 });
      x++;
      y++;
    } else if (op === "-") {
      all.push({ kind: "remove", text: a[x]!, oldLine: x + 1 });
      x++;
    } else {
      all.push({ kind: "add", text: b[y]!, newLine: y + 1 });
      y++;
    }
  }
  for (; x < a.length; x++, y++) all.push({ kind: "context", text: a[x]!, oldLine: x + 1, newLine: y + 1 });

  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((line, i) => {
    if (line.kind === "context") return;
    for (let j = Math.max(0, i - context); j <= Math.min(all.length - 1, i + context); j++) keep[j] = true;
  });

  const out: DiffLine[] = [];
  let skipped = 0;
  all.forEach((line, i) => {
    if (!keep[i]) {
      skipped++;
      return;
    }
    if (skipped > 0 && out.length > 0) out.push({ kind: "gap", count: skipped });
    skipped = 0;
    out.push(line);
  });
  return out;
}

/** Counts of added and removed lines. */
export function diffStats(diff: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff) {
    if (line.kind === "add") added++;
    else if (line.kind === "remove") removed++;
  }
  return { added, removed };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers' O((N+M)·D) shortest edit script: "=" keep, "-" remove from a, "+" add from b. */
function myers(a: string[], b: string[]): ("=" | "-" | "+")[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[k - 1 + offset]! < v[k + 1 + offset]!) ? v[k + 1 + offset]! : v[k - 1 + offset]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Walk back through the saved states to recover the path.
  const ops: ("=" | "-" | "+")[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && vd[k - 1 + offset]! < vd[k + 1 + offset]!) ? k + 1 : k - 1;
    const prevX = vd[prevK + offset]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push("=");
      x--;
      y--;
    }
    if (x === prevX) {
      ops.push("+");
      y--;
    } else {
      ops.push("-");
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push("=");
    x--;
    y--;
  }
  return ops.reverse();
}
