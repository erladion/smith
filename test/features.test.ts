import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import OpenAI from "openai";
import { Agent, type ApprovalRequest } from "../src/core/agent.js";
import { type DiffLine, diffLines } from "../src/core/diff.js";
import { loadInstructions } from "../src/core/instructions.js";
import { buildSystemPrompt } from "../src/core/prompt.js";
import { Sandbox } from "../src/core/sandbox.js";
import { loadSkills, parseFrontmatter } from "../src/core/skills.js";
import { bash } from "../src/core/tools/bash.js";
import { defaultTools } from "../src/core/tools/index.js";
import { createSkillTool } from "../src/core/tools/skill.js";
import type { ToolDef } from "../src/core/tool.js";
import { type FakeServer, startFakeServer, toolCallDeltas } from "./fake-server.js";

const tmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

/** Applies a diff's removals and additions to check it reproduces the new text. */
function applyDiff(before: string, diff: DiffLine[]): string {
  const lines = before.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const removed = new Set(diff.flatMap((d) => (d.kind === "remove" ? [d.oldLine] : [])));
  const added = diff.flatMap((d) => (d.kind === "add" ? [d] : []));
  const kept = lines.filter((_, i) => !removed.has(i + 1));
  for (const a of added) kept.splice(a.newLine - 1, 0, a.text);
  return kept.join("\n") + "\n";
}

describe("diff", () => {
  test("hunks with context, gaps and line numbers", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    const after = before.replace("line 3\n", "line three\n").replace("line 17\n", "");
    const diff = diffLines(before, after, 1);
    assert.deepEqual(
      diff.map((d) => (d.kind === "gap" ? `… ${d.count}` : `${d.kind[0]} ${d.text}`)),
      ["c line 2", "r line 3", "a line three", "c line 4", "… 11", "c line 16", "r line 17", "c line 18"],
    );
    assert.equal(applyDiff(before, diff), after);
  });

  test("reproduces random edits", () => {
    let seed = 7;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    for (let round = 0; round < 50; round++) {
      const a = Array.from({ length: rand(30) }, () => `x${rand(6)}`);
      const b = [...a];
      for (let e = 0; e < 5; e++) {
        const at = rand(b.length + 1);
        if (rand(2)) b.splice(at, 1);
        else b.splice(at, 0, `y${rand(6)}`);
      }
      const before = a.length ? a.join("\n") + "\n" : "";
      const after = b.length ? b.join("\n") + "\n" : "";
      // applyDiff always ends with a newline, so an empty result comes back as "\n".
      assert.equal(applyDiff(before, diffLines(before, after, 0)), after || "\n");
    }
  });

  test("a new file is all additions", () => {
    assert.deepEqual(diffLines("", "a\nb\n").map((d) => d.kind), ["add", "add"]);
  });
});

describe("skill headers", () => {
  test("parses the YAML forms skills use", () => {
    const { data, body } = parseFrontmatter(
      "---\nname: cpp-style\ndescription: >\n  House style for C++.\n  Use when writing C++.\nlicense: 'MIT'\nnotes: first part\n  continued here\n---\n# Body\n",
    );
    assert.deepEqual(data, {
      name: "cpp-style",
      description: "House style for C++. Use when writing C++.",
      license: "MIT",
      notes: "first part continued here",
    });
    assert.equal(body, "# Body\n");
    assert.deepEqual(parseFrontmatter("no header").data, {});
  });
});

describe("skills and instructions", () => {
  let dir: string;
  const originalConfig = process.env.XDG_CONFIG_HOME;
  beforeEach(() => {
    dir = tmp("agent-skills-");
    process.env.XDG_CONFIG_HOME = path.join(dir, "config");
  });
  afterEach(() => {
    process.env.XDG_CONFIG_HOME = originalConfig;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("project skills override personal ones; skills need a description", () => {
    const project = path.join(dir, "project", ".agents", "skills");
    const personal = path.join(dir, "personal");
    write(path.join(project, "style", "SKILL.md"), "---\nname: style\ndescription: Project style\n---\nproject body");
    write(path.join(personal, "style", "SKILL.md"), "---\nname: style\ndescription: Personal style\n---\npersonal body");
    write(path.join(personal, "deploy", "SKILL.md"), "---\ndescription: How to deploy\n---\nsteps");
    write(path.join(personal, "broken", "SKILL.md"), "---\nname: broken\n---\nno description");
    const { skills, warnings } = loadSkills([project, personal]);
    assert.deepEqual(skills.map((s) => [s.name, s.description, s.body]), [
      ["style", "Project style", "project body"],
      ["deploy", "How to deploy", "steps"],
    ]);
    assert.match(warnings.join(), /broken.*no description/);
  });

  test("instructions come from the personal file and each folder up to the repo root", () => {
    const repo = path.join(dir, "repo");
    write(path.join(dir, "config", "smith", "AGENTS.md"), "personal rules");
    write(path.join(repo, ".git", "HEAD"), "");
    write(path.join(repo, "AGENTS.md"), "repo rules");
    write(path.join(repo, "pkg", "CLAUDE.md"), "package rules (CLAUDE.md fallback)");
    write(path.join(dir, "AGENTS.md"), "outside the repo: ignored");
    const files = loadInstructions(path.join(repo, "pkg"));
    assert.deepEqual(files.map((f) => f.content), ["personal rules", "repo rules", "package rules (CLAUDE.md fallback)"]);

    const prompt = buildSystemPrompt(repo, { instructions: files, skills: [{ name: "s", description: "Do s", dir, body: "" }] });
    assert.ok(prompt.indexOf("personal rules") < prompt.indexOf("repo rules"));
    assert.match(prompt, /- s: Do s/);
  });

  test("the skill tool loads instructions and files, but not outside the skill", async () => {
    const skillDir = path.join(dir, "skills", "deploy");
    write(path.join(skillDir, "SKILL.md"), "---\ndescription: Deploying\n---\nRun scripts/deploy.sh");
    write(path.join(skillDir, "scripts", "deploy.sh"), "echo deploying");
    const tool = createSkillTool(loadSkills([path.join(dir, "skills")]).skills);
    const ctx = { cwd: dir, signal: new AbortController().signal };
    const main = await tool.run(tool.schema.parse({ name: "deploy" }), ctx);
    assert.match(main.content, /Run scripts\/deploy\.sh[\s\S]*- scripts\/deploy\.sh/);
    assert.equal((await tool.run(tool.schema.parse({ name: "deploy", file: "scripts/deploy.sh" }), ctx)).content, "echo deploying");
    await assert.rejects(tool.run(tool.schema.parse({ name: "deploy", file: "../../config" }), ctx), /outside/);
    assert.equal((await tool.run(tool.schema.parse({ name: "nope" }), ctx)).isError, true);
  });
});

describe("approval previews and undo", () => {
  let fake: FakeServer;
  let dir: string;
  before(async () => {
    fake = await startFakeServer();
  });
  after(() => fake.close());
  beforeEach(() => {
    dir = tmp("agent-undo-");
    fake.requests = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const makeAgent = (approvals: ApprovalRequest[] = []) =>
    new Agent({
      client: new OpenAI({ baseURL: fake.baseURL, apiKey: "x", maxRetries: 0 }),
      model: "fake",
      cwd: dir,
      tools: defaultTools,
      systemPrompt: "test",
      onEvent: () => {},
      approve: async (req) => {
        approvals.push(req);
        return "allow";
      },
    });

  test("the approval shows the diff; a failing edit doesn't ask", async () => {
    write(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
    fake.script = [
      { deltas: toolCallDeltas("edit_file", { path: "a.txt", old_string: "two", new_string: "TWO" }), finish: "tool_calls" },
      { deltas: toolCallDeltas("edit_file", { path: "a.txt", old_string: "missing", new_string: "x" }, "call_2"), finish: "tool_calls" },
      { deltas: [{ content: "done" }], finish: "stop" },
    ];
    const approvals: ApprovalRequest[] = [];
    await makeAgent(approvals).send("edit", new AbortController().signal);
    assert.equal(approvals.length, 1, "only the edit that can apply is shown");
    assert.deepEqual(approvals[0]!.preview!.map((d) => d.kind), ["context", "remove", "add", "context"]);
    assert.match(fake.requests[2]!.messages.at(-1).content, /^Error: old_string was not found/);
  });

  test("undo restores files, drops the turn and returns the message", async () => {
    write(path.join(dir, "keep.txt"), "original\n");
    const agent = makeAgent();
    fake.script = [{ deltas: [{ content: "hi" }], finish: "stop" }];
    await agent.send("first turn", new AbortController().signal);
    const historyAfterFirst = agent.messages.length;

    fake.script = [
      { deltas: toolCallDeltas("edit_file", { path: "keep.txt", old_string: "original", new_string: "changed" }), finish: "tool_calls" },
      { deltas: toolCallDeltas("write_file", { path: "new.txt", content: "created\n" }, "call_2"), finish: "tool_calls" },
      { deltas: toolCallDeltas("bash", { command: "true" }, "call_3"), finish: "tool_calls" },
      { deltas: [{ content: "done" }], finish: "stop" },
    ];
    await agent.send("change things", new AbortController().signal);
    assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "changed\n");

    const result = await agent.undo();
    assert.equal(result?.prompt, "change things");
    assert.deepEqual(result?.restored.map((f) => path.basename(f)).sort(), ["keep.txt", "new.txt"]);
    assert.deepEqual(result?.untracked, ["bash"]);
    assert.equal(fs.readFileSync(path.join(dir, "keep.txt"), "utf8"), "original\n");
    assert.equal(fs.existsSync(path.join(dir, "new.txt")), false);
    assert.equal(agent.messages.length, historyAfterFirst);
  });

  test("undo leaves alone files changed after the agent wrote them", async () => {
    const agent = makeAgent();
    fake.script = [
      { deltas: toolCallDeltas("write_file", { path: "f.txt", content: "agent\n" }), finish: "tool_calls" },
      { deltas: [{ content: "done" }], finish: "stop" },
    ];
    await agent.send("write", new AbortController().signal);
    fs.writeFileSync(path.join(dir, "f.txt"), "edited by hand\n");
    const result = await agent.undo();
    assert.deepEqual(result?.skipped.map((f) => path.basename(f)), ["f.txt"]);
    assert.equal(fs.readFileSync(path.join(dir, "f.txt"), "utf8"), "edited by hand\n");
    assert.equal(await agent.undo(), null);
  });
});

let bwrap = true;
try {
  Sandbox.create("on", false);
} catch {
  bwrap = false;
}

test("skill folders are readable inside the sandbox", { skip: !bwrap && "bwrap is not available" }, async () => {
  const project = tmp("agent-proj-");
  const skills = fs.mkdtempSync(path.join(os.homedir(), ".agent-test-skills-"));
  try {
    write(path.join(skills, "hello.sh"), "echo hello from the skill");
    const sandbox = Sandbox.create("on", false);
    const ctx = { cwd: project, signal: new AbortController().signal, sandbox };
    const tool = bash as ToolDef;
    const command = `bash ${skills}/hello.sh; touch ${skills}/x 2>&1 | grep -o 'Read-only'`;
    sandbox.readOnlyPaths = [skills];
    assert.equal((await tool.run(tool.schema.parse({ command }), ctx)).content, "hello from the skill\nRead-only");
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(skills, { recursive: true, force: true });
  }
});
