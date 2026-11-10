import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { BackgroundJobs } from "../src/core/jobs.js";
import { bash, createBashTool } from "../src/core/tools/bash.js";
import { createJobTools } from "../src/core/tools/jobs.js";
import { editFile, readFile, writeFile } from "../src/core/tools/files.js";
import { glob, grep, list } from "../src/core/tools/search.js";
import { buildSystemPrompt } from "../src/core/prompt.js";
import { fastTools, resetFastTools } from "../src/core/toolchain.js";
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

  test("writes stay inside the working directory, even through a symlink", async () => {
    await assert.rejects(run(writeFile, { path: "../outside.txt", content: "x" }), /outside the working directory/);
    await fs.symlink(os.tmpdir(), path.join(dir, "escape"));
    await assert.rejects(run(writeFile, { path: "escape/pwned.txt", content: "x" }), /outside the working directory/);
  });

  test("reads outside the working directory are allowed but ask for approval", async () => {
    const reason = (tool: ToolDef, input: object) => tool.approvalReason!(tool.schema.parse(input), ctx);
    assert.equal(await reason(readFile, { path: "sub/a.txt" }), undefined);
    assert.match((await reason(readFile, { path: "/etc/hostname" }))!, /outside the project/);
    assert.match((await reason(grep, { pattern: "x", path: "../.." }))!, /outside the project/);
    assert.match((await reason(glob, { pattern: "*", path: "/usr" }))!, /outside the project/);
    assert.equal(await reason(grep, { pattern: "x" }), undefined);
    // Approval is the agent's job; called directly, the tool just reads.
    assert.match((await run(readFile, { path: "/etc/os-release" })).content, /^1\t/);
  });

  test("credentials, /proc and agent data are off limits, however they're reached", async () => {
    const originalHome = process.env.HOME;
    // Not under /tmp: that is off limits by itself and would hide whether the ~/.ssh rule works.
    const home = await fs.mkdtemp(path.join(os.homedir(), ".agent-test-home-"));
    process.env.HOME = home;
    try {
      await fs.mkdir(path.join(home, ".ssh"));
      await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "PRIVATE");
      await fs.symlink(path.join(home, ".ssh"), path.join(dir, "keys"));
      for (const p of ["~/.ssh/id_ed25519", path.join(home, ".ssh/id_ed25519"), "keys/id_ed25519", "/proc/self/environ"]) {
        await assert.rejects(run(readFile, { path: p }), /off limits/, p);
      }
      await assert.rejects(run(grep, { pattern: "PRIVATE", path: "~/.ssh" }), /off limits/);
      await assert.rejects(run(glob, { pattern: "*", path: "/proc" }), /off limits/);
    } finally {
      process.env.HOME = originalHome;
      await fs.rm(home, { recursive: true, force: true });
    }
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

describe("fast tools", () => {
  const withoutRipgrep = async (fn: () => Promise<void>) => {
    const original = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin"; // a PATH without ~/.cargo/bin etc.
    resetFastTools();
    try {
      await fn();
    } finally {
      process.env.PATH = original;
      resetFastTools();
    }
  };

  test("with ripgrep, glob skips what .gitignore ignores", { skip: !fastTools().rg && "rg not installed" }, async () => {
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    await run(writeFile, { path: ".gitignore", content: "generated/\n" });
    await run(writeFile, { path: "generated/out.ts", content: "" });
    await run(writeFile, { path: "kept/in.ts", content: "" });
    const res = await run(glob, { pattern: "**/*.ts" });
    assert.match(res.content, /kept\/in\.ts/);
    assert.doesNotMatch(res.content, /generated/);
  });

  test("without ripgrep, grep and glob fall back to grep and a directory walk", async () => {
    await run(writeFile, { path: "fallback/a.txt", content: "needle here\n" });
    await withoutRipgrep(async () => {
      if (existsSync("/usr/bin/rg")) return; // rg installed system-wide: nothing to fall back from
      assert.equal(fastTools().rg, undefined);
      assert.match((await run(grep, { pattern: "needle", path: "fallback" })).content, /fallback\/a\.txt:1:needle here/);
      assert.match((await run(glob, { pattern: "fallback/*.txt" })).content, /fallback\/a\.txt/);
    });
  });

  test("the system prompt only suggests tools that are installed", async () => {
    assert.match(buildSystemPrompt("/x", { fastTools: { rg: "/usr/bin/rg", fd: "/usr/bin/fdfind" } }), /rg \(ripgrep\) instead of grep -r, fdfind instead of find/);
    assert.doesNotMatch(buildSystemPrompt("/x", { fastTools: {} }), /Faster tools/);
  });
});

describe("write protection", () => {
  test("file tools refuse to write into .git", async () => {
    await assert.rejects(run(writeFile, { path: ".git/hooks/pre-commit", content: "evil" }), /Refusing to modify \.git/);
    const edit = await run(editFile, { path: ".git/config", old_string: "a", new_string: "b" });
    assert.equal(edit.isError, true);
    assert.match(edit.content, /Refusing to modify \.git/);
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

describe("list_files", () => {
  let base: string;
  before(async () => {
    base = path.join(dir, "tree");
    const write = (rel: string) => fs.mkdir(path.dirname(path.join(base, rel)), { recursive: true }).then(() => fs.writeFile(path.join(base, rel), ""));
    for (const rel of ["README.md", "src/main.ts", "src/lib/a.ts", "src/lib/deep/b.ts", "node_modules/x/index.js"]) await write(rel);
    for (let i = 0; i < 45; i++) await write(`many/f${String(i).padStart(2, "0")}.txt`);
  });

  test("a tree, folders first, deeper folders collapsed to a count, skipped folders left out", async () => {
    const out = (await run(list, { path: "tree" })).content;
    assert.equal(
      out.split("\n").filter((l) => !l.includes("many/") && !/^ {4}f\d\d\.txt|more files$/.test(l)).join("\n"),
      ["tree/ (49 files)", "  src/", "    lib/ (2 files)", "    main.ts", "  README.md"].join("\n"),
    );
    assert.match(out, /^ {2}many\/\n {4}f00\.txt/m);
    assert.match(out, /^ {4}… 5 more files$/m, "at most 40 files per folder");
    assert.match((await run(list, { path: "tree", depth: 1 })).content, /^ {2}src\/ \(3 files\)$/m);
    assert.match((await run(list, { path: "tree", depth: 3 })).content, /^ {6}deep\/ \(1 file\)$/m);
  });

  test("says what's wrong with a file, a missing folder or an empty one", async () => {
    assert.match((await run(list, { path: "tree/README.md" })).content, /is a file; read it with read_file/);
    assert.match((await run(list, { path: "nope" })).content, /nope doesn't exist/);
    await fs.mkdir(path.join(dir, "empty"));
    assert.match((await run(list, { path: "empty" })).content, /empty is empty/);
  });
});

describe("background jobs", () => {
  const jobs = new BackgroundJobs();
  const bg = createBashTool(jobs);
  const [output, kill] = createJobTools(jobs) as [ToolDef, ToolDef];
  after(() => jobs.clear());

  test("a background command returns at once; its output is read in pieces", async () => {
    const started = Date.now();
    const res = await run(bg, { command: "echo first; sleep 1.5; echo second", run_in_background: true });
    assert.ok(Date.now() - started < 1500);
    assert.match(res.content, /^Started background job bg1\b[\s\S]*Output so far:\nfirst/);
    assert.equal(jobs.running, 1);

    const waited = await run(output, { id: "bg1", wait_ms: 5000 });
    assert.match(waited.content, /^first\nsecond\n\n\[Job bg1: exited with code 0\]$/, "what the start showed stays unread");
    assert.match((await run(output, { id: "bg1" })).content, /^\(no new output\)/);
    assert.equal(jobs.running, 0);
  });

  test("until stops waiting as soon as the output matches", async () => {
    const res = await run(bg, { command: "sleep 0.3; echo 'server listening on :8080'; sleep 30", run_in_background: true });
    const id = /job (bg\d+)/.exec(res.content)![1]!;
    const started = Date.now();
    const ready = await run(output, { id, wait_ms: 10_000, until: "listening on" });
    assert.ok(Date.now() - started < 5_000);
    assert.match(ready.content, /server listening on :8080[\s\S]*running; the output matched \/listening on\//);
    assert.match((await run(kill, { id })).content, new RegExp(`Stopped job ${id} \\(stopped \\(SIGKILL\\)\\)`));
    assert.match((await run(kill, { id })).content, /had already ended/);
  });

  test("bash_kill stops what the job started too; unknown ids and failures say so", async () => {
    const res = await run(bg, { command: "sleep 30 & sleep 30; wait", run_in_background: true });
    const id = /job (bg\d+)/.exec(res.content)![1]!;
    await run(kill, { id });
    assert.equal(jobs.running, 0);
    await assert.rejects(run(output, { id: "bg99" }), /No background job bg99\. Jobs: bg1, bg2, bg3\./);
    const failed = await run(bg, { command: "echo nope >&2; exit 4", run_in_background: true });
    assert.equal(failed.isError, true);
    assert.match(failed.content, /exited with code 4 right away[\s\S]*nope/);
    assert.equal(kill.subagents, false, "sub-agents can read jobs, not stop them");
  });

  test("clear stops every job and starts the numbering again", async () => {
    await run(bg, { command: "sleep 30", run_in_background: true });
    assert.equal(jobs.clear(), 1);
    assert.deepEqual(jobs.list(), []);
    assert.match((await run(bg, { command: "sleep 30", run_in_background: true })).content, /job bg1\b/);
    jobs.clear();
  });
});
