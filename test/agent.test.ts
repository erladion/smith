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
