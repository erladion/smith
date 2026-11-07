// src/tui/ is a general terminal toolkit: it must not know about the agent,
// so it could become its own package without changes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const TUI = path.join(import.meta.dirname, "..", "src", "tui");

test("src/tui imports only Node built-ins and its own files", () => {
  const files = fs.readdirSync(TUI).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0);
  const offenders: string[] = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(TUI, file), "utf8");
    for (const [, spec] of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      if (spec!.startsWith("node:")) continue;
      if (spec!.startsWith("./") && !spec!.slice(2).includes("/")) continue;
      offenders.push(`${file}: ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], "src/tui must not import from core/, ui/ or npm packages");
});
