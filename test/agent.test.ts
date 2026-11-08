// Runs the real agent loop against a fake OpenAI-compatible server.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import OpenAI from "openai";
import { Agent, type AgentOptions, type ApprovalDecision } from "../src/core/agent.js";
import { SUMMARY_PREFIX } from "../src/core/context.js";
import type { AgentEvent } from "../src/core/events.js";
import type { HistoryChange, Message } from "../src/core/history.js";
import { defaultTools } from "../src/core/tools/index.js";
import { defineTool } from "../src/core/tool.js";
import type { ToolRun } from "../src/core/toollog.js";
import { z } from "zod";
import { type FakeServer, startFakeServer, toolCallDeltas } from "./fake-server.js";

let fake: FakeServer;
let dir: string;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-loop-"));
  fake = await startFakeServer();
});
after(async () => {
  await fake.close();
  await fs.rm(dir, { recursive: true, force: true });
});
beforeEach(() => {
  fake.requests = [];
  fake.script = [];
});

function makeAgent(decision: ApprovalDecision = "allow", extra: Partial<AgentOptions> = {}) {
  const events: AgentEvent[] = [];
  const approvals: string[] = [];
  const changes: HistoryChange[] = [];
  const agent = new Agent({
    client: new OpenAI({ baseURL: fake.baseURL, apiKey: "x", maxRetries: 0 }),
    model: "fake",
    cwd: dir,
    tools: defaultTools,
    systemPrompt: "test",
    onEvent: (e) => events.push(e),
    onHistory: (c) => changes.push(c),
    approve: async (req) => {
      approvals.push(req.summary);
      return decision;
    },
    ...extra,
  });
  return { agent, events, approvals, changes };
}

const textOf = (events: AgentEvent[], kind: "text" | "reasoning") =>
  events.flatMap((e) => (e.type === "delta" && e.kind === kind ? [e.text] : [])).join("");

test("runs a streamed tool call and feeds the result back", async () => {
  fake.script = [
    { deltas: [{ reasoning_content: "I should run it." }, ...toolCallDeltas("bash", { command: "echo hello" })], finish: "tool_calls" },
    { deltas: [{ content: "It printed " }, { content: "hello." }], finish: "stop" },
  ];
  const { agent, events, approvals, changes } = makeAgent();
  await agent.send("say hello", new AbortController().signal);

  assert.deepEqual(approvals, ["echo hello"]);
  const toolEnd = events.find((e) => e.type === "tool_end");
  assert.ok(toolEnd?.type === "tool_end" && toolEnd.output === "hello" && !toolEnd.isError);

  // Second request carries the assistant tool call, its reasoning, and the tool result.
  const [, assistant, tool] = fake.requests[1]!.messages.slice(1);
  assert.equal(assistant.tool_calls[0].function.arguments, '{"command":"echo hello"}');
  assert.equal(assistant.reasoning_content, "I should run it.");
  assert.deepEqual(tool, { role: "tool", tool_call_id: "call_1", content: "hello" });

  assert.equal(textOf(events, "text"), "It printed hello.");
  assert.deepEqual(events.at(-1), { type: "done", reason: "stop" });
  assert.equal(agent.messages.length, 5);
  // Every message after the system prompt was reported for persistence.
  assert.deepEqual(changes.map((c) => c.type), ["append", "append", "append", "append"]);
});

test("a denied tool call is reported to the model as an error", async () => {
  fake.script = [
    { deltas: toolCallDeltas("bash", { command: "rm -rf build" }), finish: "tool_calls" },
    { deltas: [{ content: "OK, I won't." }], finish: "stop" },
  ];
  const { agent } = makeAgent("deny");
  await agent.send("clean up", new AbortController().signal);

  const tool = fake.requests[1]!.messages.at(-1);
  assert.equal(tool.role, "tool");
  assert.match(tool.content, /^Error: The user declined/);
});

test("invalid tool arguments come back as an error the model can fix", async () => {
  fake.script = [
    {
      deltas: [{ tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: '{"file":"x"}' } }] }],
      finish: "tool_calls",
    },
    { deltas: [{ content: "Retrying." }], finish: "stop" },
  ];
  const { agent } = makeAgent();
  await agent.send("read x", new AbortController().signal);
  assert.match(fake.requests[1]!.messages.at(-1).content, /Invalid arguments[\s\S]*path/);
});

test("inline <think> tags become reasoning, not text", async () => {
  fake.script = [{ deltas: [{ content: "<thi" }, { content: "nk>plan it</th" }, { content: "ink>The answer." }], finish: "stop" }];
  const { agent, events } = makeAgent();
  await agent.send("q", new AbortController().signal);
  assert.equal(textOf(events, "reasoning"), "plan it");
  assert.equal(textOf(events, "text"), "The answer.");
  assert.equal(agent.messages.at(-1)!.content, "The answer.");
});

test("reasoning level and model switches show up in requests", async () => {
  fake.script = [
    { deltas: [{ content: "a" }], finish: "stop" },
    { deltas: [{ content: "b" }], finish: "stop" },
  ];
  const { agent } = makeAgent("allow", { reasoning: "high" });
  await agent.send("one", new AbortController().signal);
  agent.setModel("other-model", undefined);
  agent.setReasoning("off");
  await agent.send("two", new AbortController().signal);

  const [first, second] = fake.requests;
  assert.equal(first!.reasoning_effort, "high");
  assert.deepEqual(first!.chat_template_kwargs, { enable_thinking: true, reasoning_effort: "high" });
  assert.equal(second!.model, "other-model");
  assert.equal(second!.reasoning_effort, undefined);
  assert.deepEqual(second!.chat_template_kwargs, { enable_thinking: false });
});

test("compacts with a summary when the context fills up", async () => {
  const history: Message[] = [];
  for (let i = 0; i < 6; i++) {
    history.push({ role: "user", content: `question ${i} ${"x".repeat(1500)}` });
    history.push({ role: "assistant", content: `answer ${i} ${"y".repeat(1500)}` });
  }
  fake.script = [
    { content: "<think>hmm</think>Summary: the user asked six questions." },
    { deltas: [{ content: "Done." }], finish: "stop" },
  ];
  const { agent, changes, events } = makeAgent("allow", { history, contextSize: 4000 });
  await agent.send("latest question", new AbortController().signal);

  // First request is the non-streamed summary of the older messages.
  assert.equal(fake.requests[0]!.stream, undefined);
  assert.match(fake.requests[0]!.messages[1].content, /question 0/);

  // The real request starts with the summary and keeps the latest question.
  const sent = fake.requests[1]!.messages;
  assert.ok(sent[1].content.startsWith(`${SUMMARY_PREFIX}Summary: the user asked six questions.`));
  assert.match(sent.at(-1).content, /latest question/);
  assert.ok(sent.length < history.length);
  assert.ok(changes.some((c) => c.type === "replace"));
  assert.ok(events.some((e) => e.type === "notice" && /Summarized/.test(e.text)));
});

test("recovers from a llama.cpp context-overflow error by compacting and retrying", async () => {
  const filler = "w".repeat(4000);
  const history: Message[] = [
    { role: "user", content: `first task ${filler}` },
    { role: "assistant", content: `did the first task ${filler}` },
    { role: "user", content: `second task ${filler}` },
    { role: "assistant", content: `did the second task ${filler}` },
  ];
  fake.script = [
    {
      status: 400,
      error: {
        code: 400,
        message: "the request exceeds the available context size, try increasing it",
        type: "exceed_context_size_error",
        n_prompt_tokens: 9000,
        n_ctx: 8192,
      },
    },
    { content: "Summary of the two tasks." },
    { deltas: [{ content: "OK." }], finish: "stop" },
  ];
  const { agent, events } = makeAgent("allow", { history });
  await agent.send("third task", new AbortController().signal);

  assert.equal(fake.requests.length, 3);
  assert.ok(fake.requests[2]!.messages[1].content.startsWith(SUMMARY_PREFIX));
  assert.deepEqual(events.at(-1), { type: "done", reason: "stop" });
  // The server's n_ctx was learned from the error.
  const ctx = events.findLast((e) => e.type === "context");
  assert.equal(ctx?.type === "context" && ctx.limit, 8192);
});

test("stops after maxSteps model calls and can continue with another message", async () => {
  // A model that keeps calling tools and never answers.
  const glob = (id: string) => ({ deltas: toolCallDeltas("glob", { pattern: "*.none" }, id), finish: "tool_calls" });
  fake.script = [glob("a"), glob("b"), glob("c")];
  const { agent, events } = makeAgent("allow", { maxSteps: 2 });
  await agent.send("loop", new AbortController().signal);

  assert.equal(fake.requests.length, 2);
  assert.deepEqual(events.at(-1), { type: "done", reason: "max_steps" });
  assert.ok(events.some((e) => e.type === "notice" && /Stopped after 2 model calls[\s\S]*maxSteps/.test(e.text)));

  fake.script = [{ deltas: [{ content: "finished" }], finish: "stop" }];
  await agent.send("continue", new AbortController().signal);
  assert.deepEqual(events.at(-1), { type: "done", reason: "stop" });
});

/** A read-only tool that takes `ms` to run and records when it ran. */
const timeline: { name: string; start: number; end: number }[] = [];
const slowTool = defineTool({
  name: "slow",
  description: "test",
  schema: z.object({ label: z.string() }),
  readOnly: true,
  summarize: ({ label }) => label,
  async run({ label }) {
    const start = Date.now();
    await new Promise((r) => setTimeout(r, 200));
    timeline.push({ name: label, start, end: Date.now() });
    return { content: `done ${label}` };
  },
});

const twoCalls = (a: string, b: string) => [
  { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "slow", arguments: JSON.stringify({ label: a }) } }] },
  { tool_calls: [{ index: 1, id: "c2", type: "function", function: { name: "slow", arguments: JSON.stringify({ label: b }) } }] },
];

test("read-only tool calls in one response run in parallel, results in order", async () => {
  timeline.length = 0;
  fake.script = [
    { deltas: twoCalls("first", "second"), finish: "tool_calls" },
    { deltas: [{ content: "ok" }], finish: "stop" },
  ];
  const { agent } = makeAgent("allow", { tools: [...defaultTools, slowTool] });
  await agent.send("go", new AbortController().signal);

  const [a, b] = timeline;
  assert.ok(a && b && a.start < b.end && b.start < a.end, "the two runs overlapped");
  const tools = fake.requests[1]!.messages.filter((m: { role: string }) => m.role === "tool");
  assert.deepEqual(tools.map((m: { content: string }) => m.content), ["done first", "done second"]);
  assert.equal(fake.requests[0]!.parallel_tool_calls, true);
});

test("a message typed during a tool call is delivered before the next model call", async () => {
  fake.script = [
    { deltas: toolCallDeltas("glob", { pattern: "*.none" }), finish: "tool_calls" },
    { deltas: [{ content: "adjusted" }], finish: "stop" },
  ];
  let agentRef: Agent | undefined;
  const { agent, events } = makeAgent("allow", {
    onEvent: (e) => {
      events.push(e);
      if (e.type === "tool_start") agentRef?.queue("actually, only look in src/");
    },
  });
  agentRef = agent;
  await agent.send("find things", new AbortController().signal);

  const sent = fake.requests[1]!.messages.slice(-2);
  assert.equal(sent[0].role, "tool");
  assert.deepEqual(sent[1], { role: "user", content: "actually, only look in src/" });
  assert.ok(events.some((e) => e.type === "user_message" && e.text === "actually, only look in src/"));
  assert.equal(agent.queuedMessages.length, 0);
});

test("a message typed during the final answer keeps the turn going", async () => {
  fake.script = [
    { deltas: [{ content: "Here is my answer." }], finish: "stop" },
    { deltas: [{ content: "Updated answer." }], finish: "stop" },
  ];
  let queued = false;
  let agentRef: Agent | undefined;
  const { agent, events } = makeAgent("allow", {
    onEvent: (e) => {
      events.push(e);
      if (e.type === "delta" && !queued) {
        queued = true;
        agentRef?.queue("also mention the tests");
      }
    },
  });
  agentRef = agent;
  await agent.send("answer", new AbortController().signal);
  assert.equal(fake.requests.length, 2);
  assert.deepEqual(fake.requests[1]!.messages.at(-1), { role: "user", content: "also mention the tests" });
  assert.deepEqual(events.at(-1), { type: "done", reason: "stop" });
});

test("a sub-agent investigates in its own context and only its report comes back", async () => {
  fake.script = [
    { deltas: toolCallDeltas("task", { description: "find config", prompt: "Where is the port configured?" }), finish: "tool_calls" },
    // The sub-agent's own request: searches, then reports.
    { deltas: toolCallDeltas("grep", { pattern: "port" }, "s1"), finish: "tool_calls" },
    { deltas: [{ content: "The port is set in config/server.ts:12." }], finish: "stop" },
    { deltas: [{ content: "It's in config/server.ts." }], finish: "stop" },
  ];
  const { agent, events } = makeAgent("allow", { subagentPrompt: "SUBAGENT PROMPT" });
  await agent.send("where is the port set?", new AbortController().signal);

  const child = fake.requests[1]!;
  assert.equal(child.messages[0].content, "SUBAGENT PROMPT");
  assert.deepEqual(child.messages.slice(1), [{ role: "user", content: "Where is the port configured?" }]);
  const childTools = child.tools.map((t: { function: { name: string } }) => t.function.name).sort();
  assert.deepEqual(childTools, ["glob", "grep", "read_file"], "read-only tools only, no nested task tool");

  const parentAfter = fake.requests[3]!.messages;
  assert.equal(parentAfter.at(-1).content, "The port is set in config/server.ts:12.");
  assert.ok(!JSON.stringify(parentAfter).includes("s1"), "the sub-agent's own tool calls stay out of the main conversation");
  assert.ok(events.some((e) => e.type === "activity" && /find config › grep/.test(e.text)));
});

const readCall = (index: number, id: string, file: string) => ({
  tool_calls: [{ index, id, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: file }) } }],
});

test("reads outside the project ask, one prompt at a time; always-allow covers the rest", async () => {
  await fs.writeFile(path.join(dir, "inside.txt"), "in\n");
  fake.script = [
    { deltas: [readCall(0, "r1", "inside.txt"), readCall(1, "r2", "/etc/hostname"), readCall(2, "r3", "/etc/os-release")], finish: "tool_calls" },
    { deltas: [{ content: "read them" }], finish: "stop" },
  ];
  const asked: { summary: string; note?: string }[] = [];
  let open = 0;
  let overlapped = false;
  const { agent } = makeAgent("allow", {
    approve: async (req) => {
      overlapped ||= open > 0;
      open++;
      asked.push({ summary: req.summary, note: req.note });
      await new Promise((r) => setTimeout(r, 50));
      open--;
      return "allow_always";
    },
  });
  await agent.send("read", new AbortController().signal);

  // The two outside reads resolve their paths in parallel, so either may ask first.
  assert.equal(asked.length, 1, "asked once, then always-allowed");
  assert.match(asked[0]!.summary, /^\/etc\/(hostname|os-release)$/);
  assert.equal(asked[0]!.note, "Reads outside the project folder.");
  assert.equal(overlapped, false);
  const results = fake.requests[1]!.messages.filter((m: { role: string }) => m.role === "tool").map((m: { content: string }) => m.content);
  assert.match(results[0], /^1\tin/);
  assert.ok(results.every((c: string) => !c.startsWith("Error")));
});

test("a sub-agent reading outside the project asks through the main agent", async () => {
  fake.script = [
    { deltas: toolCallDeltas("task", { description: "check hosts", prompt: "Read /etc/hostname" }), finish: "tool_calls" },
    { deltas: [readCall(0, "s1", "/etc/hostname")], finish: "tool_calls" },
    { deltas: [{ content: "hostname read" }], finish: "stop" },
    { deltas: [{ content: "done" }], finish: "stop" },
  ];
  const notes: (string | undefined)[] = [];
  const { agent } = makeAgent("allow", {
    subagentPrompt: "SUB",
    approve: async (req) => {
      notes.push(req.note);
      return "deny";
    },
  });
  await agent.send("go", new AbortController().signal);
  assert.deepEqual(notes, ['Sub-agent "check hosts": Reads outside the project folder.']);
  const childResult = fake.requests[2]!.messages.at(-1);
  assert.match(childResult.content, /^Error: The user declined/);
});

test("loading a saved conversation replaces history without recording it", async () => {
  const { agent, changes } = makeAgent();
  agent.loadConversation([
    { role: "user", content: "earlier" },
    { role: "assistant", content: "reply" },
  ]);
  assert.deepEqual(agent.messages.slice(1).map((m) => m.content), ["earlier", "reply"]);
  assert.deepEqual(changes, []);
  assert.equal(agent.canUndo, false);
});

test("a resumed history with an unanswered tool call is repaired", async () => {
  const history: Message[] = [
    { role: "user", content: "do it" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
  ];
  fake.script = [{ deltas: [{ content: "Continuing." }], finish: "stop" }];
  const { agent } = makeAgent("allow", { history });
  await agent.send("go on", new AbortController().signal);
  const sent = fake.requests[0]!.messages;
  assert.equal(sent[3].role, "tool");
  assert.equal(sent[3].tool_call_id, "t1");
});

test("reports every tool call for the tool log, whatever its outcome", async () => {
  const call = (index: number, name: string, args: object) => ({
    tool_calls: [{ index, id: `t${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
  });
  const runs: ToolRun[] = [];
  fake.script = [
    { deltas: [call(0, "bash", { command: "echo logged" }), call(1, "no_such_tool", {}), call(2, "glob", { pattern: "*.nothing" })], finish: "tool_calls" },
    { deltas: toolCallDeltas("bash", { command: "echo refused" }), finish: "tool_calls" },
    { deltas: toolCallDeltas("task", { description: "look", prompt: "look around" }), finish: "tool_calls" },
    // The sub-agent's call, then its report, then the parent's answer.
    { deltas: toolCallDeltas("glob", { pattern: "*.md" }, "s1"), finish: "tool_calls" },
    { deltas: [{ content: "nothing here" }], finish: "stop" },
    { deltas: [{ content: "done" }], finish: "stop" },
  ];
  const decisions: ApprovalDecision[] = ["allow", "deny"];
  const { agent } = makeAgent("allow", {
    approve: async () => decisions.shift()!,
    onToolRun: (run) => runs.push(run),
    subagentPrompt: "SUB",
  });
  await agent.send("go", new AbortController().signal);

  assert.deepEqual(
    runs.map((r) => [r.tool, r.status, r.approval, r.subagent]),
    [
      ["bash", "ok", "allowed", undefined],
      ["no_such_tool", "invalid", undefined, undefined],
      ["glob", "ok", "not needed", undefined],
      ["bash", "denied", "denied", undefined],
      ["glob", "ok", "not needed", "look"],
      ["task", "ok", "not needed", undefined],
    ],
  );
  assert.deepEqual(runs[0]!.input, { command: "echo logged" });
  assert.equal(runs[0]!.output, "logged");
  assert.equal(runs[5]!.output, "nothing here");
  assert.ok(runs.every((r) => !Number.isNaN(Date.parse(r.time)) && r.durationMs >= 0));
});

const todoCall = (todos: { content: string; status: string }[], id = "todo1") => toolCallDeltas("todo_write", { todos }, id);

test("todo_write keeps a checklist, and a model that stops early is reminded once", async () => {
  fake.script = [
    { deltas: todoCall([{ content: "Read the code", status: "in_progress" }, { content: "Fix the bug", status: "pending" }]), finish: "tool_calls" },
    // Stops with steps left: reminded.
    { deltas: [{ content: "I looked at it." }], finish: "stop" },
    { deltas: todoCall([{ content: "Read the code", status: "completed" }, { content: "Fix the bug", status: "in_progress" }], "todo2"), finish: "tool_calls" },
    // Stops again: not reminded twice in one turn.
    { deltas: [{ content: "Still on it." }], finish: "stop" },
  ];
  const { agent, events } = makeAgent();
  await agent.send("fix it", new AbortController().signal);

  assert.equal(fake.requests.length, 4);
  const reminder = fake.requests[2]!.messages.at(-1);
  assert.equal(reminder.role, "user");
  assert.match(reminder.content, /^\[Reminder\] Your todo list still has unfinished steps:\n\[>\] Read the code\n\[ \] Fix the bug/);
  assert.match(fake.requests[1]!.messages.at(-1).content, /Todo list updated \(0\/2 done\)/);
  assert.deepEqual(agent.todos.map((t) => t.status), ["completed", "in_progress"]);
  assert.equal(events.filter((e) => e.type === "todos").length, 2);
  assert.ok(events.some((e) => e.type === "notice" && /Reminded the agent of 2 unfinished todos/.test(e.text)));
});

test("the checklist comes back with a saved conversation and survives compaction", async () => {
  const todos = [{ content: "Write tests", status: "completed" }, { content: "Ship it", status: "pending" }];
  const history: Message[] = [
    { role: "user", content: "plan it" },
    { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "todo_write", arguments: JSON.stringify({ todos }) } }] },
    { role: "tool", tool_call_id: "t1", content: "Todo list updated" },
    { role: "assistant", content: "Planned." },
  ];
  // Long enough that the start gets summarized.
  for (let i = 0; i < 4; i++) history.push({ role: "user", content: "x".repeat(1500) }, { role: "assistant", content: "y".repeat(1500) });
  const { agent } = makeAgent("allow", { history, contextSize: 4000 });
  assert.deepEqual(agent.todos, todos);

  fake.script = [{ content: "We planned the work." }];
  await agent.compactNow(new AbortController().signal);
  const intro = agent.messages[1]!;
  assert.match(String(intro.content), /Your todo list so far:\n\[x\] Write tests\n\[ \] Ship it/);
});

test("sub-agents get no checklist and no questions; ask_user is offered only with a way to ask", async () => {
  fake.script = [{ deltas: [{ content: "hi" }], finish: "stop" }];
  await makeAgent().agent.send("hi", new AbortController().signal);
  const names = (i: number) => fake.requests[i]!.tools.map((t: { function: { name: string } }) => t.function.name);
  assert.ok(names(0).includes("todo_write"));
  assert.ok(!names(0).includes("ask_user"));

  fake.script = [{ deltas: [{ content: "hi" }], finish: "stop" }];
  await makeAgent("allow", { ask: async () => null }).agent.send("hi", new AbortController().signal);
  assert.ok(names(1).includes("ask_user"));
});

test("ask_user waits for the answer: an option, the user's own words, or dismissed", async () => {
  const ask = (index: number, id: string, question: string) => ({
    tool_calls: [{ index, id, type: "function", function: { name: "ask_user", arguments: JSON.stringify({ question, options: ["Postgres", "SQLite"] }) } }],
  });
  fake.script = [
    // Two questions in one response are asked one after the other.
    { deltas: [ask(0, "q1", "Which database?"), ask(1, "q2", "Which port?")], finish: "tool_calls" },
    { deltas: [{ content: "OK." }], finish: "stop" },
  ];
  const asked: string[] = [];
  let open = 0;
  const answers = [{ option: 1 }, { text: "5433, please" }];
  const { agent } = makeAgent("allow", {
    ask: async (q) => {
      assert.equal(open++, 0, "one question at a time");
      asked.push(q.question);
      await new Promise((r) => setTimeout(r, 10));
      open--;
      return answers.shift()!;
    },
  });
  await agent.send("set up a database", new AbortController().signal);
  assert.deepEqual(asked, ["Which database?", "Which port?"]);
  const results = fake.requests[1]!.messages.filter((m: { role: string }) => m.role === "tool").map((m: { content: string }) => m.content);
  assert.deepEqual(results, ["The user chose: SQLite", "The user answered: 5433, please"]);

  fake.script = [
    { deltas: [ask(0, "q3", "Which one?")], finish: "tool_calls" },
    { deltas: [{ content: "Fine." }], finish: "stop" },
  ];
  const dismissed = makeAgent("allow", { ask: async () => null }).agent;
  await dismissed.send("pick", new AbortController().signal);
  assert.match(fake.requests.at(-1)!.messages.at(-1).content, /^Error: The user dismissed the question/);
});
