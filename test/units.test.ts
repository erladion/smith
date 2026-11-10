import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import OpenAI from "openai";
import { chooseTail, SUMMARY_PREFIX, trimOldToolResults } from "../src/core/context.js";
import { configDir, dataDir, moveOldFolders } from "../src/core/dirs.js";
import { describeError } from "../src/core/errors.js";
import type { Message } from "../src/core/history.js";
import { defaultName, deleteSession, findSession, listSessions, secureSessions, Session, sessionsDir } from "../src/core/session.js";
import { loadPreferences, savePreferences } from "../src/core/preferences.js";
import { ThinkTagParser } from "../src/core/think.js";
import { runLaterChanges, runLaterReason, snapshotRunLater } from "../src/core/runlater.js";
import { truncateLog } from "../src/core/tool.js";
import { buildSystemPrompt } from "../src/core/prompt.js";
import { ToolLog, toolLogFile } from "../src/core/toollog.js";

describe("ThinkTagParser", () => {
  const run = (chunks: string[]) => {
    const p = new ThinkTagParser();
    const segs = [...chunks.flatMap((c) => p.push(c)), ...p.flush()];
    const join = (k: string) => segs.filter((s) => s.kind === k).map((s) => s.text).join("");
    return { text: join("text"), reasoning: join("reasoning") };
  };

  test("handles tags split at every position", () => {
    const full = "<think>deep thoughts</think>final answer";
    for (let i = 1; i < full.length; i++) {
      assert.deepEqual(run([full.slice(0, i), full.slice(i)]), { text: "final answer", reasoning: "deep thoughts" }, `split at ${i}`);
    }
  });

  test("drops a stray closing tag and keeps look-alike text", () => {
    assert.deepEqual(run(["reasoning?</think>answer"]), { text: "reasoning?answer", reasoning: "" });
    assert.deepEqual(run(["a < b and <thing>"]), { text: "a < b and <thing>", reasoning: "" });
    assert.deepEqual(run(["ends with <thi"]), { text: "ends with <thi", reasoning: "" });
  });
});

describe("context helpers", () => {
  test("trimOldToolResults keeps the most recent outputs", () => {
    const messages: Message[] = Array.from({ length: 5 }, (_, i) => ({
      role: "tool" as const,
      tool_call_id: `t${i}`,
      content: `output ${i} ${"z".repeat(500)}`,
    }));
    const { messages: out, count } = trimOldToolResults(messages, 3);
    assert.equal(count, 2);
    assert.match(out[0]!.content as string, /removed to save context/);
    assert.match(out[4]!.content as string, /^output 4/);
  });

  test("chooseTail never starts on a tool message", () => {
    const messages: Message[] = [
      { role: "user", content: "u" },
      { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "bash", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "a", content: "r".repeat(2000) },
      { role: "tool", tool_call_id: "b", content: "small" },
    ];
    // Budget fits only the last tool message, which can't stand alone.
    assert.equal(chooseTail(messages, 10), messages.length);
    assert.equal(chooseTail(messages, 10_000), 0);
  });
});

describe("sessions", () => {
  let dataDir: string;
  const original = process.env.XDG_DATA_HOME;
  before(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sessions-"));
    process.env.XDG_DATA_HOME = dataDir;
  });
  after(() => {
    process.env.XDG_DATA_HOME = original;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const mode = (p: string) => (fs.statSync(p).mode & 0o777).toString(8);

  test("session files and folders are private; old readable ones get tightened", () => {
    const session = Session.create("/private", "m");
    session.record({ type: "append", message: { role: "user", content: "secret stuff" } });
    assert.equal(mode(session.file), "600");
    assert.equal(mode(sessionsDir()), "700");
    assert.equal(mode(path.dirname(sessionsDir())), "700");

    // As an older version left them:
    fs.chmodSync(session.file, 0o644);
    fs.chmodSync(sessionsDir(), 0o755);
    secureSessions();
    assert.equal(mode(session.file), "600");
    assert.equal(mode(sessionsDir()), "700");

    // Reopening and writing also fixes a file's permissions.
    fs.chmodSync(session.file, 0o644);
    Session.open(session.id).session.record({ type: "append", message: { role: "assistant", content: "ok" } });
    assert.equal(mode(session.file), "600");
  });

  test("deleting a session removes its log and its tool log", () => {
    const session = Session.create("/del", "m");
    session.record({ type: "append", message: { role: "user", content: "throwaway" } });
    new ToolLog(() => session.id, () => "/del").write({ time: new Date().toISOString(), tool: "bash", input: {}, status: "ok", durationMs: 1, output: "" });
    assert.ok(fs.existsSync(toolLogFile(session.id)));
    assert.deepEqual(deleteSession(session.id), [session.file, toolLogFile(session.id)]);
    assert.ok(!fs.existsSync(session.file) && !fs.existsSync(toolLogFile(session.id)));
    assert.throws(() => deleteSession(session.id), /No session/);
    assert.throws(() => deleteSession("../config"), /Not a session id/);
  });

  test("the tool log appends one private JSON line per call to the session's log", () => {
    let id = "s-one";
    const log = new ToolLog(() => id, () => "/project");
    const run = { time: "2026-11-06T10:00:00.000Z", tool: "bash", input: { command: "ls" }, approval: "allowed" as const, status: "ok" as const, durationMs: 12, output: "a\nb" };
    log.write(run);
    log.write({ ...run, output: "x".repeat(20_000) });
    id = "s-two";
    log.write({ ...run, tool: "grep", approval: undefined, status: "invalid" });

    const lines = fs.readFileSync(toolLogFile("s-one"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines[0], { time: run.time, session: "s-one", cwd: "/project", tool: "bash", input: { command: "ls" }, approval: "allowed", status: "ok", durationMs: 12, output: "a\nb" });
    assert.equal(lines[1].output.length, 10_000);
    assert.equal(lines[1].outputChars, 20_000);
    assert.equal(JSON.parse(fs.readFileSync(toolLogFile("s-two"), "utf8")).tool, "grep");
    assert.equal(mode(toolLogFile("s-one")), "600");
    assert.equal(mode(path.dirname(toolLogFile("s-one"))), "700");
  });

  test("preferences are private", () => {
    const originalConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(dataDir, "config");
    try {
      savePreferences({ reasoning: "high" });
      assert.equal(loadPreferences().reasoning, "high");
      assert.equal(mode(path.join(dataDir, "config", "smith", "preferences.json")), "600");
      assert.equal(mode(path.join(dataDir, "config", "smith")), "700");
      assert.equal(mode(path.join(dataDir, "config")), "755", "only the agent's own folder is made private");
    } finally {
      process.env.XDG_CONFIG_HOME = originalConfig;
    }
  });

  test("sessions have names: from the first message, or set with /name", () => {
    assert.equal(defaultName("Fix the login bug. Also the tests."), "Fix the login bug.");
    assert.equal(defaultName("Please refactor the whole authentication module so that it uses the new token service"), "Please refactor the whole authentication module…");

    const early = Session.create("/names/a", "m");
    early.rename("auth-rework"); // named before the first message
    early.record({ type: "append", message: { role: "user", content: "Rework auth" } });
    const late = Session.create("/names/b", "m");
    late.record({ type: "append", message: { role: "user", content: "Add a version flag. Thanks" } });
    late.rename("version flag");
    const unnamed = Session.create("/names/c", "m");
    unnamed.record({ type: "append", message: { role: "user", content: "Look into the flaky test" } });

    const byId = new Map(listSessions().map((s) => [s.id, s]));
    assert.deepEqual([early, late, unnamed].map((s) => [byId.get(s.id)!.name, byId.get(s.id)!.named]), [
      ["auth-rework", true],
      ["version flag", true],
      ["Look into the flaky test", false],
    ]);
    assert.equal(Session.open(late.id).session.name, "version flag");

    assert.equal(findSession("AUTH-rework"), early.id, "names match ignoring case");
    assert.equal(findSession(late.id), late.id);
    Session.create("/names/d", "m").rename("auth-rework");
    const twin = Session.create("/names/e", "m");
    twin.rename("auth-rework");
    twin.record({ type: "append", message: { role: "user", content: "x" } });
    assert.throws(() => findSession("auth-rework"), /Several sessions are named "auth-rework"/);
    assert.throws(() => findSession("nope"), /No session with the id or name "nope"/);
  });

  test("records, replaces and reloads a conversation", () => {
    const session = Session.create("/proj", "m1");
    assert.equal(fs.existsSync(session.file), false, "nothing written until the first change");

    session.record({ type: "append", message: { role: "user", content: "hello there" } });
    session.record({ type: "append", message: { role: "assistant", content: "hi" } });
    session.record({ type: "replace", messages: [{ role: "user", content: "summary" }] });
    session.record({ type: "append", message: { role: "assistant", content: "after" } });
    session.recordModel("m2", "gpu-box");
    // Simulate a crash in the middle of writing a line.
    fs.appendFileSync(session.file, '{"type":"append","mess');

    const { session: reopened, messages } = Session.open(session.id);
    assert.equal(reopened.model, "m2");
    assert.equal(reopened.endpoint, "gpu-box");
    assert.deepEqual(messages, [
      { role: "user", content: "summary" },
      { role: "assistant", content: "after" },
    ]);

    const listed = listSessions("/proj");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.id, session.id);
    assert.equal(listSessions("/elsewhere").length, 0);
  });

  test("listings show the first message, skip summaries, count turns and respect the limit", async () => {
    const make = async (first: string, extra: string[]) => {
      const s = Session.create("/listing", "m");
      s.record({ type: "append", message: { role: "user", content: first } });
      for (const text of extra) s.record({ type: "append", message: { role: "user", content: text } });
      await new Promise((r) => setTimeout(r, 15)); // distinct modification times
      return s.id;
    };
    const older = await make("Fix   the\nlogin bug", ["and the tests"]);
    const newer = await make(`${SUMMARY_PREFIX}summary text\n\n---\n\nAdd a version flag`, []);

    const listed = listSessions("/listing");
    assert.deepEqual(listed.map((s) => [s.id, s.preview, s.turns]), [
      [newer, "Add a version flag", 1],
      [older, "Fix the login bug", 2],
    ]);
    assert.deepEqual(listSessions("/listing", 1).map((s) => s.id), [newer]);
  });
});

describe("connection errors", () => {
  // The SDK wraps fetch's TypeError, which wraps the system or TLS error.
  const wrapped = (code: string, message: string) =>
    new OpenAI.APIConnectionError({ cause: Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) }) });

  test("show the real cause and a hint", () => {
    const tls = describeError(wrapped("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate; if the root CA is installed locally, try running Node.js with --use-system-ca"), "https://x/v1");
    assert.match(tls, /^Could not reach https:\/\/x\/v1: unable to verify the first certificate \(UNABLE_TO_VERIFY_LEAF_SIGNATURE\)\./);
    assert.match(tls, /update-ca-trust/);
    assert.doesNotMatch(tls, /try running Node\.js/);
    assert.match(describeError(wrapped("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.5:8000"), "u"), /Nothing is listening/);
    assert.match(describeError(wrapped("ENOTFOUND", "getaddrinfo ENOTFOUND gpu-box"), "u"), /doesn't resolve/);
    assert.match(describeError(wrapped("UND_ERR_CONNECT_TIMEOUT", "Connect Timeout Error"), "u"), /HTTPS_PROXY/);
  });

  test("without a cause, the old message", () => {
    assert.match(describeError(new OpenAI.APIConnectionError({}), "u"), /Could not reach u\. Is the server running\?/);
  });
});

describe("the rename from agent to Smith", () => {
  test("moves the old folders once, and only when they hold agent's files", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "smith-rename-"));
    const saved = { config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME };
    process.env.XDG_CONFIG_HOME = path.join(base, "config");
    process.env.XDG_DATA_HOME = path.join(base, "data");
    try {
      fs.mkdirSync(path.join(base, "config", "agent"), { recursive: true });
      fs.writeFileSync(path.join(base, "config", "agent", "config.json"), "{}");
      fs.mkdirSync(path.join(base, "data", "agent", "sessions"), { recursive: true });
      fs.writeFileSync(path.join(base, "data", "agent", "sessions", "s.jsonl"), "");

      const notes = moveOldFolders();
      assert.equal(notes.length, 2);
      assert.match(notes[0]!, /agent is now called Smith/);
      assert.ok(fs.existsSync(path.join(configDir(), "config.json")));
      assert.ok(fs.existsSync(path.join(dataDir(), "sessions", "s.jsonl")));
      assert.ok(!fs.existsSync(path.join(base, "config", "agent")));

      // Done once: a later old folder (some other program's) is left alone.
      fs.mkdirSync(path.join(base, "config", "agent"));
      fs.writeFileSync(path.join(base, "config", "agent", "config.json"), "{}");
      assert.deepEqual(moveOldFolders(), []);
      assert.ok(fs.existsSync(path.join(base, "config", "agent", "config.json")));
    } finally {
      process.env.XDG_CONFIG_HOME = saved.config;
      process.env.XDG_DATA_HOME = saved.data;
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("long command output", () => {
  test("keeps the error lines from the part that's cut, with the lines after them", () => {
    const lines = [];
    for (let i = 0; i < 2000; i++) lines.push(`compiling module ${i} ... ok`);
    lines[900] = "src/parser.c:41:7: error: 'tokn' undeclared (first use in this function)";
    lines[901] = "   41 |   if (tokn == END) {";
    lines[902] = "      |       ^~~~";
    lines[1200] = "Build summary: 0 errors in the cache step";
    const out = truncateLog(lines.join("\n"), 4_000);
    assert.ok(out.length <= 4_400, `${out.length}`);
    assert.match(out, /^compiling module 0 \.\.\. ok/);
    assert.match(out, /\[\.\.\. \d+ lines omitted \.\.\.\]\nsrc\/parser\.c:41:7: error: 'tokn' undeclared.*\n {3}41 \| {3}if \(tokn == END\) \{\n {6}\| {7}\^~~~\n\[\.\.\./);
    assert.doesNotMatch(out, /0 errors in the cache step/);
    assert.match(out, /compiling module 1999 \.\.\. ok$/);
    assert.equal(truncateLog("short", 100), "short");
  });

  test("the prompt tells the model where commands run and how to build", () => {
    const prompt = buildSystemPrompt("/p", { sandbox: ["Commands run in a test sandbox."] });
    assert.match(prompt, /Where commands run:\n- Commands run in a test sandbox\./);
    assert.match(prompt, /find out how this project does it/);
    assert.match(prompt, /larger timeout_ms/);
  });
});

describe("smith --delete", () => {
  const cli = path.join(process.cwd(), "src", "cli.ts");
  const runCli = (args: string[], data: string) =>
    spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { encoding: "utf8", input: "", env: { ...process.env, XDG_DATA_HOME: data, XDG_CONFIG_HOME: path.join(data, "config") } });

  test("asks first (and refuses without a terminal); --yes deletes by name", () => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "smith-delete-"));
    const saved = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = data;
    try {
      const session = Session.create("/del", "m");
      session.record({ type: "append", message: { role: "user", content: "fix the login" } });
      session.rename("login-fix");

      const refused = runCli(["--delete", "login-fix"], data);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /Not deleting "login-fix" .* without asking; pass --yes/);
      assert.ok(fs.existsSync(session.file));

      const done = runCli(["--delete", "login-fix", "--yes"], data);
      assert.equal(done.status, 0, done.stderr);
      assert.match(done.stdout, /Deleted "login-fix" \(.+\) in \/del: 1 message/);
      assert.ok(!fs.existsSync(session.file));
    } finally {
      process.env.XDG_DATA_HOME = saved;
      fs.rmSync(data, { recursive: true, force: true });
    }
  });
});

describe("files that run outside the sandbox later", () => {
  test("are recognised by name and place, anywhere in the project", () => {
    for (const rel of [".envrc", "package.json", "web/package.json", ".vscode/tasks.json", ".husky/pre-commit", ".github/workflows/ci.yml",
      "Makefile", "lib/foo.mk", "CMakeLists.txt", "pyproject.toml", "requirements-dev.txt", "gradle/wrapper/gradle-wrapper.properties",
      "Dockerfile", "compose.yaml", ".devcontainer/devcontainer.json", ".pre-commit-config.yaml", ".gitmodules", ".npmrc"]) {
      assert.ok(runLaterReason(rel), rel);
    }
    for (const rel of ["src/main.ts", "README.md", "package-lock.json", "docs/Makefile.md", "src/github/workflows.ts"]) assert.equal(runLaterReason(rel), undefined, rel);
  });

  test("snapshots tell what was created, changed or deleted", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smith-snap-"));
    try {
      fs.writeFileSync(path.join(dir, "Makefile"), "a");
      fs.writeFileSync(path.join(dir, "package.json"), "{}");
      fs.writeFileSync(path.join(dir, "main.c"), "x");
      const before = snapshotRunLater(dir);
      assert.deepEqual([...before.keys()].sort(), ["Makefile", "package.json"]);
      fs.writeFileSync(path.join(dir, "Makefile"), "b");
      fs.rmSync(path.join(dir, "package.json"));
      fs.mkdirSync(path.join(dir, ".vscode"));
      fs.writeFileSync(path.join(dir, ".vscode", "tasks.json"), "{}");
      fs.writeFileSync(path.join(dir, "main.c"), "y");
      assert.deepEqual(
        runLaterChanges(before, snapshotRunLater(dir)).map((c) => `${c.rel} ${c.kind}`),
        [".vscode/tasks.json created", "Makefile changed", "package.json deleted"],
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
