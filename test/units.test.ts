import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chooseTail, SUMMARY_PREFIX, trimOldToolResults } from "../src/core/context.js";
import type { Message } from "../src/core/history.js";
import { listSessions, Session } from "../src/core/session.js";
import { ThinkTagParser } from "../src/core/think.js";

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
