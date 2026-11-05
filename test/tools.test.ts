import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { bash } from "../src/core/tools/bash.js";
import { editFile, readFile, writeFile } from "../src/core/tools/files.js";
import { glob, grep } from "../src/core/tools/search.js";
import type { ToolContext, ToolDef } from "../src/core/tool.js";

let dir: string;
let ctx: ToolContext;
const run = (tool: ToolDef, input: unknown) => tool.run(tool.schema.parse(input), ctx);

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-tools-"));
  ctx = { cwd: dir, signal: new AbortController().signal };
});
after(() => fs.rm(dir, { recursive: true, force: true }));

describe("file tools", () => {
  test("write then read returns numbered lines", async () => {
    await run(writeFile, { path: "sub/a.txt", content: "one\ntwo\nthree\n" });
    const res = await run(readFile, { path: "sub/a.txt", offset: 2, limit: 1 });
    assert.equal(res.isError, undefined);
    assert.match(res.content, /^2\ttwo/);
    assert.match(res.content, /Showing lines 2-2 of 3/);
  });

  test("edit_file requires a unique match", async () => {
    await run(writeFile, { path: "b.txt", content: "x = 1\nx = 1\n" });
    const dup = await run(editFile, { path: "b.txt", old_string: "x = 1", new_string: "x = 2" });
    assert.equal(dup.isError, true);
    assert.match(dup.content, /occurs 2 times/);

    const all = await run(editFile, { path: "b.txt", old_string: "x = 1", new_string: "x = $&2", replace_all: true });
    assert.equal(all.isError, undefined);
    assert.equal(await fs.readFile(path.join(dir, "b.txt"), "utf8"), "x = $&2\nx = $&2\n");
  });

  test("paths outside the working directory are rejected", async () => {
    await assert.rejects(run(readFile, { path: "../../etc/passwd" }), /outside the working directory/);
    await fs.symlink(os.tmpdir(), path.join(dir, "escape"));
    await assert.rejects(run(writeFile, { path: "escape/pwned.txt", content: "x" }), /outside the working directory/);
  });
});

describe("search tools", () => {
  test("grep finds matches and reports none cleanly", async () => {
    await run(writeFile, { path: "src/app.ts", content: "const answer = 42;\nfunction main() {}\n" });
    await run(writeFile, { path: "src/notes.md", content: "answer pending\n" });

    const hits = await run(grep, { pattern: "answer\\s*=", glob: "*.ts" });
    assert.equal(hits.isError, undefined);
    assert.match(hits.content, /src\/app\.ts:1:const answer = 42;/);
    assert.doesNotMatch(hits.content, /notes\.md/);

    const files = await run(grep, { pattern: "answer", files_only: true, path: "src" });
    assert.deepEqual(files.content.split("\n").sort(), ["src/app.ts", "src/notes.md"]);

    assert.equal((await run(grep, { pattern: "nothing-matches-this" })).content, "No matches.");
    await assert.rejects(run(grep, { pattern: "x", path: "../.." }), /outside the working directory/);
  });

  test("glob lists matching files and skips node_modules", async () => {
    await run(writeFile, { path: "node_modules/pkg/index.ts", content: "" });
    const res = await run(glob, { pattern: "**/*.ts" });
    assert.match(res.content, /src\/app\.ts/);
    assert.doesNotMatch(res.content, /node_modules/);
    assert.equal((await run(glob, { pattern: "**/*.nope" })).content, "No files matched.");
  });

  test("glob patterns can't leave the working directory", async () => {
    for (const pattern of ["../*", "src/../../*", "/etc/*"]) {
      const res = await run(glob, { pattern });
      assert.equal(res.isError, true, pattern);
    }
  });

  test("glob syntax", async () => {
    await run(writeFile, { path: "g/a.test.ts", content: "" });
    await run(writeFile, { path: "g/deep/b.test.js", content: "" });
    await run(writeFile, { path: "g/c.md", content: "" });
    const res = await run(glob, { pattern: "g/**/*.test.{ts,js}" });
    assert.deepEqual(res.content.split("\n").sort(), ["g/a.test.ts", "g/deep/b.test.js"]);
    assert.equal((await run(glob, { pattern: "g/?.md" })).content, "g/c.md");
    assert.equal((await run(glob, { pattern: "*.md" })).content, "No files matched.", "no slash means top level only");
  });
});

describe("write protection", () => {
  test("file tools refuse to write into .git", async () => {
    await assert.rejects(run(writeFile, { path: ".git/hooks/pre-commit", content: "evil" }), /Refusing to modify \.git/);
    await assert.rejects(run(editFile, { path: ".git/config", old_string: "a", new_string: "b" }), /Refusing to modify \.git/);
  });
});

describe("bash tool", () => {
  test("captures output and exit codes", async () => {
    const ok = await run(bash, { command: "echo hi; echo err >&2" });
    assert.equal(ok.isError, undefined);
    assert.match(ok.content, /hi\nerr/);

    const fail = await run(bash, { command: "exit 3" });
    assert.equal(fail.isError, true);
    assert.match(fail.content, /Exit code 3/);
  });

  test("kills commands that time out", async () => {
    const started = Date.now();
    const res = await run(bash, { command: "sleep 5", timeout_ms: 200 });
    assert.equal(res.isError, true);
    assert.match(res.content, /timed out/);
    assert.ok(Date.now() - started < 3000);
  });
});
