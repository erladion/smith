import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { LineEditor } from "../src/tui/editor.js";
import { TODO_REMINDER } from "../src/core/agent.js";
import { box, todoLines } from "../src/ui/entries.js";
import { historyToEntries } from "../src/ui/replay.js";
import { questionBox } from "../src/ui/view.js";
import { farewell, greeting } from "../src/ui/greetings.js";
import { KeyReader } from "../src/tui/keys.js";
import { inline, markdownLines, safeSplit } from "../src/tui/markdown.js";
import { Picker } from "../src/tui/picker.js";
import { isGitRepo, listFolders, shortPath } from "../src/ui/folders.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codeStream, Rain } from "../src/tui/rain.js";
import { InlineRenderer } from "../src/tui/renderer.js";
import { type Line, setColors, toAnsi } from "../src/tui/style.js";
import { lineWidth, sanitize, textWidth, truncate, wrap } from "../src/tui/text.js";

const plain = (lines: Line[]) => lines.map((l) => l.map((s) => s.text).join(""));

describe("text width", () => {
  test("counts terminal columns", () => {
    assert.equal(textWidth("hello"), 5);
    assert.equal(textWidth("日本語"), 6);
    assert.equal(textWidth("é"), 1, "combining accent");
    assert.equal(textWidth("👍🏽"), 2, "emoji with skin tone");
    assert.equal(textWidth("👨‍👩‍👧"), 2, "family emoji joined with ZWJ");
    assert.equal(textWidth("⚠️"), 2, "symbol with emoji presentation");
  });
});

describe("sanitize", () => {
  test("strips escape sequences and control characters", () => {
    assert.equal(sanitize("ok\x1b[31mred\x1b[0m\x1b]0;title\x07\r\nnext\x08"), "okred\nnext");
    assert.equal(sanitize("a\tb"), "a    b");
  });

  test("an approval prompt can't be spoofed by a command", () => {
    // Carriage return + erase-line would hide "rm -rf ~" in a real terminal.
    const line = toAnsi([{ text: "rm -rf ~\r\x1b[2Kls" }]);
    assert.ok(!line.includes("\r") && !line.includes("\x1b[2K"));
    assert.ok(line.includes("rm -rf ~"));
  });
});

describe("wrap", () => {
  test("wraps at spaces without a leading space on the next line", () => {
    assert.deepEqual(plain(wrap([{ text: "the quick brown fox jumps" }], 10)), ["the quick", "brown fox", "jumps"]);
  });

  test("keeps newlines and indentation, splits long words", () => {
    assert.deepEqual(plain(wrap([{ text: "a\n  indented\nabcdefghij" }], 4)), ["a", "  in", "dent", "ed", "abcd", "efgh", "ij"]);
  });

  test("keeps styles across wrapped lines", () => {
    const lines = wrap([{ text: "plain " }, { text: "bold words here", style: { bold: true } }], 11);
    assert.deepEqual(plain(lines), ["plain bold", "words here"]);
    assert.equal(lines[1]![0]!.style?.bold, true);
  });

  test("wraps wide characters by width", () => {
    assert.deepEqual(plain(wrap([{ text: "日本語のテキスト" }], 6)), ["日本語", "のテキ", "スト"]);
  });
});

test("truncate cuts to width with an ellipsis", () => {
  assert.deepEqual(plain([truncate([{ text: "abcdef" }], 4)]), ["abc…"]);
  assert.deepEqual(plain([truncate([{ text: "abc" }], 4)]), ["abc"]);
  assert.equal(lineWidth(truncate([{ text: "日本語のテキスト" }], 5)), 5);
});

describe("markdown", () => {
  test("inline styles", () => {
    const spans = inline("use `npm test`, **bold**, *it* and snake_case_name");
    assert.deepEqual(
      spans.map((s) => [s.text, s.style?.color ?? (s.style?.bold ? "bold" : s.style?.italic ? "italic" : "")]),
      [["use ", ""], ["npm test", "cyan"], [", ", ""], ["bold", "bold"], [", ", ""], ["it", "italic"], [" and snake_case_name", ""]],
    );
  });

  test("blocks: headings, lists, code", () => {
    const text = "# Title\n\n- one\n- two that wraps\n\n```ts\nconst x = 1;\n```\n1. first";
    assert.deepEqual(plain(markdownLines(text, 14)), ["Title", "", "• one", "• two that", "  wraps", "", "│ const x = 1;", "1. first"]);
  });

  test("streamed text is only split outside code blocks", () => {
    assert.equal(safeSplit("para one\n\npara two"), 8);
    assert.equal(safeSplit("intro\n\n```\ncode\n\nmore code"), 5);
    assert.equal(safeSplit("```\na\n\nb"), -1);
  });
});

describe("keys", () => {
  test("parses typing, arrows, modifiers and controls", () => {
    const keys = new KeyReader().feed("ab\x1b[A\x1b[1;5C\x7f\r\x03\x1bb\x1b");
    assert.deepEqual(keys, [
      { name: "text", text: "ab" },
      { name: "up", shift: false, meta: false, ctrl: false },
      { name: "right", shift: false, meta: false, ctrl: true },
      { name: "backspace" },
      { name: "return" },
      { name: "char", text: "c", ctrl: true },
      { name: "char", text: "b", meta: true },
      { name: "escape" },
    ]);
  });

  test("kitty keyboard protocol: shift+enter, esc and ctrl keys", () => {
    const keys = new KeyReader().feed("\x1b[13;2u\x1b[27u\x1b[99;5u\x1b[97;3u\x1b[13u");
    assert.deepEqual(
      keys.map((k) => [k.name, k.text ?? "", k.shift ? "shift" : k.ctrl ? "ctrl" : k.meta ? "alt" : ""]),
      [["return", "", "shift"], ["escape", "", ""], ["char", "c", "ctrl"], ["char", "a", "alt"], ["return", "", ""]],
    );
  });

  test("alt+enter and ctrl+j are distinct from enter", () => {
    const keys = new KeyReader().feed("\x1b\r\n\r");
    assert.deepEqual(keys, [{ name: "return", meta: true }, { name: "return", ctrl: true }, { name: "return" }]);
  });

  test("bracketed paste keeps newlines, even across reads", () => {
    const reader = new KeyReader();
    assert.deepEqual(reader.feed("\x1b[200~line one\nline"), []);
    assert.deepEqual(reader.feed(" two\x1b[201~x"), [{ name: "paste", text: "line one\nline two" }, { name: "text", text: "x" }]);
  });
});

describe("line editor", () => {
  const type = (editor: LineEditor, data: string) => {
    for (const key of new KeyReader().feed(data)) if (editor.handle(key) === "submit") return true;
    return false;
  };

  test("edits by character and word", () => {
    const e = new LineEditor();
    type(e, "hello wörld");
    type(e, "\x1b[D\x1b[D\x7f"); // left, left, backspace
    assert.equal(e.value, "hello wöld");
    type(e, "\x17"); // ctrl+w
    assert.equal(e.value, "hello ld");
    type(e, "\x1b[F\x01X"); // end, ctrl+a, X
    assert.equal(e.value, "Xhello ld");
  });

  test("shift+enter, alt+enter, ctrl+j and backslash-enter add new lines", () => {
    const e = new LineEditor();
    const submitted = type(e, "one\x1b[13;2utwo\x1b\rthree\nfour\\\rfive");
    assert.equal(submitted, false);
    assert.equal(e.value, "one\ntwo\nthree\nfour\nfive");
    assert.equal(type(e, "\r"), true, "plain enter still submits");
  });

  test("the cursor stays visible at the end of the input", () => {
    const e = new LineEditor();
    type(e, "abc");
    assert.deepEqual(plain(wrap(e.render("placeholder"), 10)), ["abc "]);
    // When the text fills the line exactly, the cursor moves to the next one rather than vanishing.
    const full = wrap(e.render("placeholder"), 3);
    assert.deepEqual(plain(full), ["abc", " "]);
    assert.ok(full[1]!.some((s) => s.style?.inverse));
  });

  test("enter submits and history recalls earlier lines", () => {
    const e = new LineEditor();
    assert.equal(type(e, "first\r"), true);
    assert.equal(e.commit(), "first");
    type(e, "second");
    e.commit();
    type(e, "draft\x1b[A");
    assert.equal(e.value, "second");
    type(e, "\x1b[A");
    assert.equal(e.value, "first");
    type(e, "\x1b[B\x1b[B");
    assert.equal(e.value, "draft");
  });
});

test("picker filters and selects", () => {
  const picker = new Picker("Pick", [
    { value: "a", label: "qwen3-coder" },
    { value: "b", label: "gpt-oss-20b" },
    { value: "c", label: "qwen3-small" },
  ]);
  for (const key of new KeyReader().feed("qwen\x1b[B")) picker.handle(key);
  assert.deepEqual(picker.handle({ name: "return" }), { value: "c" });
  assert.equal(picker.handle({ name: "escape" }), "cancel");
});

test("picker: backspace with nothing typed goes back", () => {
  const picker = new Picker("Folder", [{ value: "a", label: "alpha/" }], undefined, { back: "up" });
  for (const key of new KeyReader().feed("al")) picker.handle(key);
  assert.equal(picker.handle({ name: "backspace" }), undefined, "first it edits the filter");
  picker.handle({ name: "backspace" });
  assert.deepEqual(picker.handle({ name: "backspace" }), { value: "up" });
});

test("picker: an action key asks y/n first, and can refuse", () => {
  const picker = new Picker("Sessions", [{ value: "cur", label: "current one" }, { value: "old", label: "old one" }], "cur", {
    action: { key: "d", hint: "delete", check: (item) => (item.value === "cur" ? { refuse: "Not this one." } : { ask: `Delete ${item.label}?` }) },
  });
  const text = () => picker.lines().map((l) => l.map((s) => s.text).join(""));
  assert.match(text()[1]!, /ctrl\+d delete/);
  const ctrlD = { name: "char", ctrl: true, text: "d" } as const;

  assert.equal(picker.handle(ctrlD), undefined);
  assert.equal(text()[1], "Not this one.", "refused for the current item");
  picker.handle({ name: "down" });
  picker.handle(ctrlD);
  assert.equal(text()[1], "Delete old one? y/n");
  assert.equal(picker.handle({ name: "text", text: "n" }), undefined, "n backs out");
  assert.match(text()[1]!, /type to filter/);
  picker.handle(ctrlD);
  assert.deepEqual(picker.handle({ name: "text", text: "y" }), { value: "old", action: true });
});

test("folder listing: sorted, hidden and files left out, symlinked folders kept", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-folders-"));
  try {
    for (const d of ["beta", "Alpha", ".hidden", "repo/.git"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
    fs.writeFileSync(path.join(dir, "file.txt"), "");
    fs.symlinkSync(path.join(dir, "beta"), path.join(dir, "link"));
    assert.deepEqual(listFolders(dir).names, ["Alpha", "beta", "link", "repo"]);
    assert.equal(isGitRepo(path.join(dir, "repo")), true);
    assert.equal(isGitRepo(path.join(dir, "beta")), false);
    assert.match(listFolders(path.join(dir, "missing")).error ?? "", /ENOENT|no such/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("box pads lines to the same width", () => {
  const lines = plain(box([[{ text: "hi" }], [{ text: "longer" }]], "cyan", 40));
  assert.deepEqual(lines, ["╭────────╮", "│ hi     │", "│ longer │", "╰────────╯"]);
});

describe("renderer", () => {
  const screen = () => {
    const writes: string[] = [];
    return { writes, columns: 20, rows: 10, write: (s: string) => writes.push(s) };
  };
  const strip = (s: string) => s.replace(/\x1b\[\?2026[hl]/g, "");

  test("prints above the live region and erases exactly the live rows", () => {
    setColors(false);
    const s = screen();
    const r = new InlineRenderer(s);
    r.draw([[{ text: "live 1" }], [{ text: "live 2" }]]);
    assert.equal(strip(s.writes[0]!), "live 1\r\nlive 2");
    r.print([[{ text: "done" }]]);
    r.draw([[{ text: "input" }]]);
    // Back to column 0, up one row (two live rows), clear down, then output.
    assert.equal(strip(s.writes[1]!), "\r\x1b[1A\x1b[Jdone\r\ninput");
    setColors(true);
  });

  test("an unchanged frame isn't redrawn", () => {
    const s = screen();
    const r = new InlineRenderer(s);
    r.draw([[{ text: "same" }]]);
    r.draw([[{ text: "same" }]]);
    assert.equal(s.writes.length, 1);
    r.print([[{ text: "new" }]]);
    r.draw([[{ text: "same" }]]);
    assert.equal(s.writes.length, 2, "queued output still gets printed");
  });

  test("reset clears the screen and forgets the old live region", () => {
    const s = screen();
    const r = new InlineRenderer(s);
    r.draw([[{ text: "a" }], [{ text: "b" }]]);
    r.reset();
    r.draw([[{ text: "c" }]]);
    assert.equal(s.writes[1], "\x1b[H\x1b[2J\x1b[3J");
    assert.equal(strip(s.writes[2]!), "c", "nothing left to erase after a reset");
  });
});

test("Agent Smith greets Mr. Anderson, fitting how the session started", () => {
  const now = Date.parse("2026-11-07T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms);
  for (const r of [0, 0.5, 0.999]) {
    for (const context of [{ resumed: false as const }, { resumed: false as const, newFolder: true }, { resumed: true as const }, { resumed: true as const, lastUsed: ago(60_000) }, { resumed: true as const, lastUsed: ago(40 * 86_400_000) }]) {
      assert.match(greeting(context, () => r, now), /Mr\. Anderson/);
    }
  }
  assert.equal(greeting({ resumed: true }, () => 0, now), "We meet again, Mr. Anderson.");
  assert.equal(greeting({ resumed: true, lastUsed: ago(3 * 3_600_000) }, () => 0, now), "We meet again, Mr. Anderson.");
  assert.equal(greeting({ resumed: true, lastUsed: ago(5 * 60_000) }, () => 0, now), "Back so soon, Mr. Anderson?");
  assert.match(greeting({ resumed: true, lastUsed: ago(30 * 86_400_000) }, () => 0, now), /long time/);
  assert.match(greeting({ resumed: false, newFolder: true }, () => 0, now), /new place/);
});

test("the farewell counts long runs", () => {
  assert.equal(farewell(20 * 60_000), "Goodbye, Mr. Anderson.");
  assert.equal(farewell(70 * 60_000), "An hour, Mr. Anderson. It is inevitable. Goodbye.");
  assert.equal(farewell(3.5 * 3_600_000), "Three hours, Mr. Anderson. It is inevitable. Goodbye.");
  assert.equal(farewell(30 * 3_600_000), "30 hours, Mr. Anderson. It is inevitable. Goodbye.");
});

test("durations and turn summaries", async () => {
  const { formatDuration, turnSummary } = await import("../src/ui/duration.js");
  assert.deepEqual([38, 4200, 42_900, 65_000, 3_725_000].map(formatDuration), ["38ms", "4.2s", "42s", "1m 05s", "1h 02m"]);
  assert.equal(turnSummary("stop", 83_000, 7), "Done in 1m 23s · 7 tool calls");
  assert.equal(turnSummary("stop", 2_500, 1), "Done in 2.5s · 1 tool call");
  assert.equal(turnSummary("stop", 2_500, 0), "Done in 2.5s");
  assert.equal(turnSummary("interrupted", 12_000, 2), "Interrupted after 12s · 2 tool calls");
  assert.equal(turnSummary("max_steps", 600_000, 50), "Stopped at the step limit after 10m 00s · 50 tool calls");
  assert.equal(turnSummary(undefined, 3_000, 0), "Stopped after 3.0s");
});

test("long folder paths keep their end", () => {
  assert.equal(shortPath("/srv/projects/work/webapp", 40), "/srv/projects/work/webapp");
  assert.equal(shortPath("/very/long/path/to/some/deep/folder/work/webapp", 20), "…/folder/work/webapp");
  assert.equal(shortPath(`${os.homedir()}/git/agent`, 40), "~/git/agent");
  assert.equal(shortPath("/x/an-extremely-long-folder-name-that-does-not-fit", 12), "…oes-not-fit", "a single name too long to fit keeps its end");
});

describe("command suggestions", async () => {
  const { suggest, helpText, COMMANDS } = await import("../src/ui/commands.js");
  const ctx = { cwd: os.tmpdir(), endpoints: ["local", "gpu-box"], models: ["qwen3-coder-30b", "gpt-oss-20b"] };
  const texts = (input: string, c = ctx) => suggest(input, c).map((s) => s.text);

  test("typing / lists every command, more letters narrow it down", () => {
    assert.equal(texts("/").length, COMMANDS.length);
    assert.deepEqual(texts("/h"), ["/help"]);
    assert.deepEqual(texts("/n").slice(0, 3), ["/name", "/new", "/network"]);
    assert.equal(texts("/net")[0], "/network");
    assert.deepEqual(texts("/xyz"), []);
  });

  test("arguments complete after the command and a space", () => {
    assert.deepEqual(texts("/reasoning "), ["/reasoning default", "/reasoning off", "/reasoning low", "/reasoning medium", "/reasoning high"]);
    assert.deepEqual(texts("/reasoning h"), ["/reasoning high"]);
    assert.deepEqual(texts("/network o"), ["/network on", "/network off"]);
    assert.deepEqual(texts("/sessions "), ["/sessions all"]);
    assert.deepEqual(texts("/endpoint g"), ["/endpoint gpu-box"]);
    assert.deepEqual(texts("/model oss"), ["/model gpt-oss-20b"]);
    assert.deepEqual(texts("/help "), [], "no arguments to complete");
  });

  test("/new completes folders, going deeper with each /", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-complete-"));
    try {
      for (const d of ["webapp/src", "web-old", "billing", ".hidden"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
      const at = { ...ctx, cwd: dir };
      assert.deepEqual(texts("/new we", at), ["/new web-old/", "/new webapp/"]);
      assert.deepEqual(texts("/new webapp/", at), ["/new webapp/src/"]);
      assert.deepEqual(texts("/new .h", at), ["/new .hidden/"], "hidden folders when the name starts with a dot");
      assert.equal(suggest("/new we", at)[0]!.takesArgument, true);
      assert.ok(texts("/new ~/", at).every((t) => t.startsWith("/new ~/")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ordinary messages get no suggestions; help lists every command", () => {
    assert.deepEqual(texts("fix the bug"), []);
    assert.deepEqual(texts("/help\nmore"), []);
    for (const c of COMMANDS) assert.match(helpText(), new RegExp(c.name.replace("/", "\\/")));
  });
});

describe("digital rain", () => {
  // A seeded generator, so a failure can be replayed.
  const seeded = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const rows = (frame: string) =>
    frame
      .split(/\x1b\[\d+;1H/)
      .slice(1)
      .map((row) => row.replace(/\x1b\[[\d;]*m/g, ""));

  test("every frame fills the screen exactly, one column per glyph", () => {
    const rain = new Rain(60, 20, { title: "AGENT SMITH", random: seeded(1) });
    while (!rain.done) {
      rain.step();
      const shown = rows(rain.render());
      assert.equal(shown.length, 20);
      for (const row of shown) assert.equal(textWidth(row), 60);
    }
  });

  test("the title appears gradually and is complete, centered, at the end", () => {
    const rain = new Rain(61, 21, { title: "AGENT SMITH", frames: 30, holdFrames: 5, random: seeded(7) });
    assert.equal(rain.shownTitle.trim(), "");
    for (let i = 0; i < 30; i++) rain.step();
    assert.equal(rain.shownTitle, "AGENT SMITH");
    assert.ok(!rain.done, "the finished title is held for a moment");
    for (let i = 0; i < 5; i++) rain.step();
    assert.ok(rain.done);
    const middle = rows(rain.render())[10]!;
    assert.equal(middle.indexOf("AGENT SMITH"), 25);
  });
});

describe("matrix extras", () => {
  test("rain as lines: an endless strip, every line exactly as wide as asked", () => {
    const strip = new Rain(22, 3, { title: "", frames: Infinity });
    let lit = 0;
    for (let i = 0; i < 300; i++) {
      strip.step();
      const lines = strip.lines();
      assert.equal(lines.length, 3);
      for (const line of lines) {
        assert.equal(lineWidth(line), 22);
        lit += line.filter((s) => s.style).length;
      }
    }
    assert.ok(!strip.done, "an endless rain never finishes");
    assert.ok(lit > 0, "it rains");
  });

  test("the code stream scrolls one column to the left per step", () => {
    const now = codeStream(41, 20);
    assert.equal(textWidth(now), 20);
    assert.equal(codeStream(42, 19), now.slice(1));
    assert.match(now, / /, "it has gaps");
  });

  test("the status line puts the code stream in spare room at its right end", async () => {
    const { statusLine } = await import("../src/ui/view.js");
    const sandbox = { active: true, network: false } as never;
    const status = { endpoint: "local", model: "m", reasoning: "default", context: null, sandbox, busy: false, queueing: false };
    const plain = statusLine(status, 80);
    const streamed = statusLine({ ...status, filler: (n) => "ｱ".repeat(n) }, 80);
    assert.equal(lineWidth(streamed), 80);
    assert.ok(streamed.map((s) => s.text).join("").endsWith("ｱ".repeat(24)));
    assert.deepEqual(statusLine({ ...status, filler: (n) => "ｱ".repeat(n) }, 40), statusLine(status, 40), "no room, no stream");
    assert.ok(lineWidth(plain) < 80);
  });
});

describe("todos and questions", () => {
  const text = (lines: Line[]) => lines.map((l) => l.map((s) => s.text).join("").trimEnd());

  test("the checklist shows progress and each step's state", () => {
    const todos = [
      { content: "Read the code", status: "completed" as const },
      { content: "Fix the bug", status: "in_progress" as const },
      { content: "Run the tests", status: "pending" as const },
    ];
    assert.deepEqual(text(todoLines(todos, 40)), ["● Todos 1/3 done", "  ✔ Read the code", "  ▶ Fix the bug", "  ○ Run the tests"]);
    assert.deepEqual(text(todoLines([], 40)), ["● Todos cleared"]);
  });

  test("the question box numbers the options and marks the selected one", () => {
    const lines = text(questionBox({ question: "Which database?", options: ["Postgres", "SQLite"] }, 1, 60));
    assert.ok(lines.includes("│ Which database?                                          │"));
    assert.ok(lines.some((l) => l.startsWith("│   1. Postgres")));
    assert.ok(lines.some((l) => l.startsWith("│ › 2. SQLite")));
    assert.ok(lines.some((l) => l.includes("or 1-2, picks")));
    const open = text(questionBox({ question: "Anything else?", options: [] }, 0, 60));
    assert.ok(open.some((l) => l.includes("type your answer below")));
  });

  test("a resumed session shows its checklists and reminders, not raw calls", () => {
    const todos = [{ content: "Ship it", status: "pending" }];
    const entries = historyToEntries(
      [
        { role: "user", content: "go" },
        { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "todo_write", arguments: JSON.stringify({ todos }) } }] },
        { role: "tool", tool_call_id: "t1", content: "Todo list updated" },
        { role: "user", content: `${TODO_REMINDER}\n[ ] Ship it` },
      ],
      [],
    );
    assert.deepEqual(entries.map((e) => e.kind), ["user", "todos", "notice"]);
  });
});
