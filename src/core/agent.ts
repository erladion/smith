import { randomUUID } from "node:crypto";
import type OpenAI from "openai";
import { z } from "zod";
import {
  CHARS_PER_TOKEN,
  chooseTail,
  contextOverflow,
  estimateTokens,
  renderTranscript,
  SUMMARY_INSTRUCTIONS,
  SUMMARY_PREFIX,
  trimOldToolResults,
} from "./context.js";
import type { DiffLine } from "./diff.js";
import type { AgentEvent, DoneReason } from "./events.js";
import { type ReasoningLevel, reasoningParams } from "./reasoning.js";
import { Sandbox } from "./sandbox.js";
import { type HistoryChange, type Message, messageText, repairHistory } from "./history.js";
import { stripThinkTags, ThinkTagParser } from "./think.js";
import { type ToolDef, type ToolResult, toApiTool, truncate } from "./tool.js";
import { createTaskTool, type TaskInput } from "./tools/task.js";
import { Checkpoint, restore } from "./undo.js";

type AssistantMessage = OpenAI.Chat.Completions.ChatCompletionAssistantMessageParam;

export type ApprovalDecision = "allow" | "allow_always" | "deny";

export interface ApprovalRequest {
  tool: string;
  summary: string;
  input: unknown;
  /** For tools that run in the sandbox: what the sandbox allows, or that there is none. */
  sandbox?: { active: boolean; description: string };
  /** For file changes: the diff the call would apply. */
  preview?: DiffLine[];
  /** Why a normally prompt-free tool asks this time (e.g. reading outside the project). */
  note?: string;
}

export interface UndoResult {
  /** The undone turn's message, to put back in the input box. */
  prompt: string;
  restored: string[];
  /** Files left alone because they changed after the agent wrote them. */
  skipped: string[];
  /** Tools that ran in the turn whose changes can't be undone (bash). */
  untracked: string[];
}

const MAX_UNDO = 20;
const MAX_REPORT_CHARS = 8_000;

export interface AgentOptions {
  client: OpenAI;
  model: string;
  /** How hard the model should think; see reasoning.ts for what each level sends. */
  reasoning?: ReasoningLevel;
  cwd: string;
  tools: ToolDef[];
  systemPrompt: string;
  /** Sampling temperature; omitted from requests when undefined so the server default applies. */
  temperature?: number;
  /** Cap on model calls per user message, so a confused model can't loop forever. */
  maxSteps?: number;
  /** The server's context window in tokens. Enables compaction before it fills up. */
  contextSize?: number;
  /** Where shell commands run. Defaults to no sandbox. */
  sandbox?: Sandbox;
  /**
   * System prompt for sub-agents. When set, the agent gets a `task` tool that
   * runs a sub-agent with this prompt and the read-only tools.
   */
  subagentPrompt?: string;
  /** Tools the user allowed for the session; shared with sub-agents so a grant applies to both. */
  alwaysAllowed?: Set<string>;
  /** Earlier conversation to continue (without the system prompt), e.g. from a saved session. */
  history?: Message[];
  /** Called on every change to the conversation, for persistence. */
  onHistory?: (change: HistoryChange) => void;
  /**
   * Asks the user whether a non-read-only tool may run. The frontend must
   * settle this promise (with "deny") if the user interrupts while it's pending.
   */
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onEvent: (event: AgentEvent) => void;
}

interface ToolCall {
  id: string;
  name: string;
  args: string;
}

interface StreamedResponse {
  text: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  /** Prompt + completion tokens, when the server reports usage. */
  totalTokens: number | null;
}

/** Fields some OpenAI-compatible servers add to deltas (llama.cpp, vLLM, DeepSeek). */
type DeltaWithReasoning = OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
  reasoning_content?: string | null;
  reasoning?: string | null;
};

// Compact when the context is this full, and aim to get below the second figure.
const COMPACT_AT = 0.75;
const TRIM_TARGET = 0.6;
// Share of the window kept verbatim (most recent messages) when summarizing.
const TAIL_SHARE = 0.25;

export class Agent {
  private readonly history: Message[];
  private readonly toolsByName: Map<string, ToolDef>;
  private readonly apiTools: OpenAI.Chat.Completions.ChatCompletionTool[];
  private readonly alwaysAllowed: Set<string>;
  /** Approvals are asked one at a time, even when tools run in parallel. */
  private approvals: Promise<unknown> = Promise.resolve();
  /** Recent turns, newest last: where each started in the history and what it changed. */
  private turns: { start: number; prompt: string; checkpoint: Checkpoint }[] = [];
  /** Messages typed while the agent works, delivered at the next safe point. */
  private queued: string[] = [];
  private contextSize: number | undefined;
  private client: OpenAI;
  private modelId: string;
  private reasoningLevel: ReasoningLevel;
  /** Last exact token count from the server, and how many messages it covered. */
  private measured: { tokens: number; messages: number } | null = null;

  constructor(private readonly opts: AgentOptions) {
    this.history = [{ role: "system", content: opts.systemPrompt }, ...repairHistory(opts.history ?? [])];
    const tools = opts.subagentPrompt
      ? [...opts.tools, createTaskTool((input, ctx) => this.runSubagent(input, ctx.signal))]
      : opts.tools;
    this.toolsByName = new Map(tools.map((t) => [t.name, t]));
    this.apiTools = tools.map(toApiTool);
    this.contextSize = opts.contextSize;
    this.alwaysAllowed = opts.alwaysAllowed ?? new Set();
    this.client = opts.client;
    this.modelId = opts.model;
    this.reasoningLevel = opts.reasoning ?? "default";
  }

  get model(): string {
    return this.modelId;
  }

  /** The context window in tokens, if known. */
  get contextLimit(): number | undefined {
    return this.contextSize;
  }

  get reasoning(): ReasoningLevel {
    return this.reasoningLevel;
  }

  /**
   * Switches model, and optionally server, for the following requests. The
   * conversation carries over.
   */
  setModel(model: string, contextSize: number | undefined, client?: OpenAI): void {
    if (client) this.client = client;
    this.modelId = model;
    this.contextSize = contextSize;
    // Token counts from the old model's tokenizer no longer apply.
    this.measured = null;
    this.emitContext();
  }

  setReasoning(level: ReasoningLevel): void {
    this.reasoningLevel = level;
  }

  /** The full conversation, including the system prompt. */
  get messages(): readonly Message[] {
    return this.history;
  }

  /** Clears the conversation but keeps the system prompt and "always allow" grants. */
  reset(): void {
    this.replaceHistory([]);
    this.turns = [];
  }

  /**
   * Replaces the conversation with a saved one (switching sessions). Unlike
   * other changes this isn't reported to onHistory: the session being opened
   * already contains it.
   */
  loadConversation(messages: Message[]): void {
    this.history.splice(1, this.history.length, ...repairHistory(messages));
    this.measured = null;
    this.turns = [];
    this.emitContext();
  }

  /**
   * Queues a message typed while the agent works. It is handed to the model
   * between tool calls, or after the current reply, within the running turn.
   */
  queue(text: string): void {
    this.queued.push(text);
  }

  /** Queued messages not yet delivered. */
  get queuedMessages(): readonly string[] {
    return this.queued;
  }

  /** Removes and returns undelivered messages (e.g. after an interruption, to give them back). */
  takeQueued(): string[] {
    const taken = this.queued;
    this.queued = [];
    return taken;
  }

  /** Whether /undo has something to undo. */
  get canUndo(): boolean {
    return this.turns.length > 0;
  }

  /**
   * Undoes the last turn: puts back files it changed with the file tools and
   * removes the turn from the conversation. Returns null if there's nothing
   * to undo.
   */
  async undo(): Promise<UndoResult | null> {
    const turn = this.turns.pop();
    if (!turn) return null;
    const { restored, skipped } = await restore(turn.checkpoint);
    this.replaceHistory(this.history.slice(1, turn.start));
    this.emitContext();
    return { prompt: turn.prompt, restored, skipped, untracked: [...turn.checkpoint.untracked] };
  }

  /**
   * Runs one user turn: calls the model, executes any tool calls, feeds the
   * results back, and repeats until the model answers without tools.
   * Throws on API errors; interruption via `signal` is not an error.
   */
  async send(text: string, signal: AbortSignal): Promise<void> {
    this.turns.push({ start: this.history.length, prompt: text, checkpoint: new Checkpoint() });
    if (this.turns.length > MAX_UNDO) this.turns.shift();
    this.append({ role: "user", content: text });
    await this.interruptible(signal, () => this.loop(signal));
  }

  /** Summarizes the conversation now, regardless of how full the context is. */
  async compactNow(signal: AbortSignal): Promise<void> {
    await this.interruptible(signal, () => this.compact(signal, "manual"));
  }

  private async interruptible(signal: AbortSignal, work: () => Promise<unknown>): Promise<void> {
    try {
      await work();
    } catch (err) {
      if (!signal.aborted) throw err;
      this.opts.onEvent({ type: "response_end" });
      this.opts.onEvent({ type: "done", reason: "interrupted" });
    }
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const emit = this.opts.onEvent;
    const maxSteps = this.opts.maxSteps ?? 50;
    let retriedOverflow = false;

    for (let step = 0; step < maxSteps; step++) {
      if (step > 0) this.deliverQueued();
      await this.maybeCompact(signal);

      let response: StreamedResponse;
      try {
        response = await this.streamResponse(signal);
      } catch (err) {
        // The server rejected the prompt as too long: our estimate was off or
        // we didn't know the window size. Compact once and retry.
        const overflow = signal.aborted ? null : contextOverflow(err);
        if (!overflow || retriedOverflow) throw err;
        retriedOverflow = true;
        if (overflow.contextSize) this.contextSize = overflow.contextSize;
        emit({ type: "response_end" });
        emit({ type: "notice", level: "warn", text: "The conversation no longer fits the server's context window." });
        if (!(await this.compact(signal, "overflow"))) throw err;
        continue;
      }
      retriedOverflow = false;
      emit({ type: "response_end" });
      this.append(this.assistantMessage(response));
      if (response.totalTokens !== null) {
        this.measured = { tokens: response.totalTokens, messages: this.history.length };
      }
      this.emitContext();

      if (response.toolCalls.length === 0) {
        // Something you typed while it answered: keep going so the model sees it.
        if (this.queued.length > 0 && response.finishReason !== "length") continue;
        if (response.finishReason === "length") {
          emit({ type: "notice", level: "warn", text: "The response hit the server's token limit and was cut off." });
          emit({ type: "done", reason: "length" });
        } else {
          emit({ type: "done", reason: "stop" });
        }
        return;
      }

      // Every tool call needs a matching tool message, even when the user
      // interrupts partway, or the next request will be rejected.
      const results = await this.runTools(response.toolCalls, signal);
      response.toolCalls.forEach((call, i) => {
        const result = results[i]!;
        this.append({
          role: "tool",
          tool_call_id: call.id,
          content: result.isError ? `Error: ${result.content}` : result.content,
        });
      });
      if (signal.aborted) {
        emit({ type: "done", reason: "interrupted" });
        return;
      }
    }

    emit({
      type: "notice",
      level: "warn",
      text: `Stopped after ${maxSteps} model calls without a final answer. Send a message (e.g. "continue") to let it go on, or raise maxSteps in the config file.`,
    });
    emit({ type: "done", reason: "max_steps" });
  }

  /** Hands queued messages to the model as one user message. */
  private deliverQueued(): void {
    if (this.queued.length === 0) return;
    const texts = this.takeQueued();
    for (const text of texts) this.opts.onEvent({ type: "user_message", text });
    this.append({ role: "user", content: texts.join("\n\n") });
  }

  /**
   * Runs a response's tool calls, results in call order. Consecutive
   * read-only calls run in parallel; anything that may need approval runs on
   * its own, so prompts never overlap.
   */
  private async runTools(calls: ToolCall[], signal: AbortSignal): Promise<ToolResult[]> {
    const results: ToolResult[] = [];
    const interrupted = { content: "Interrupted by the user before this tool ran.", isError: true };
    const readOnly = (call: ToolCall) => this.toolsByName.get(call.name)?.readOnly === true;
    let i = 0;
    while (i < calls.length) {
      if (signal.aborted) {
        results.push(interrupted);
        i++;
        continue;
      }
      let end = i + 1;
      if (readOnly(calls[i]!)) while (end < calls.length && readOnly(calls[end]!)) end++;
      results.push(...(await Promise.all(calls.slice(i, end).map((call) => this.runTool(call, signal)))));
      i = end;
    }
    return results;
  }

  /** Runs a sub-agent for the `task` tool and returns its final report. */
  private async runSubagent({ description, prompt }: TaskInput, signal: AbortSignal): Promise<ToolResult> {
    const emit = this.opts.onEvent;
    let reason: DoneReason | undefined;
    const child = new Agent({
      client: this.client,
      model: this.modelId,
      reasoning: this.reasoningLevel,
      cwd: this.opts.cwd,
      temperature: this.opts.temperature,
      maxSteps: this.opts.maxSteps,
      contextSize: this.contextSize,
      sandbox: this.opts.sandbox,
      // Read-only tools only (which also rules out nested sub-agents).
      tools: this.opts.tools.filter((t) => t.readOnly),
      systemPrompt: this.opts.subagentPrompt!,
      alwaysAllowed: this.alwaysAllowed,
      // Its tools are read-only, but reading outside the project still asks you.
      approve: (req) => this.requestApproval({ ...req, note: `Sub-agent "${description}": ${req.note ?? ""}`.trim() }),
      onEvent: (event) => {
        if (event.type === "tool_start") emit({ type: "activity", text: `${description} › ${event.name} ${event.summary}` });
        else if (event.type === "done") reason = event.reason;
      },
    });
    emit({ type: "activity", text: `${description} › thinking…` });
    try {
      await child.send(prompt, signal);
    } catch (err) {
      return { content: `The sub-agent failed: ${err instanceof Error ? err.message : String(err)}`, isError: true };
    }
    if (reason === "interrupted") return { content: "The sub-agent was interrupted by the user.", isError: true };

    const last = [...child.messages].reverse().find((m) => m.role === "assistant" && messageText(m).trim());
    let report = last ? messageText(last).trim() : "The sub-agent finished without a report.";
    if (reason === "max_steps") report += "\n\n[The sub-agent hit its step limit before finishing; this report may be incomplete.]";
    return { content: truncate(report, MAX_REPORT_CHARS) };
  }

  // ---- context management ----

  /** Current context use: the server's last count plus an estimate for messages added since. */
  private estimateContext(): number {
    if (this.measured) return this.measured.tokens + estimateTokens(this.history.slice(this.measured.messages));
    return estimateTokens(this.history) + estimateTokens(this.apiTools);
  }

  private emitContext(): void {
    this.opts.onEvent({ type: "context", tokens: this.estimateContext(), limit: this.contextSize });
  }

  private async maybeCompact(signal: AbortSignal): Promise<void> {
    if (this.contextSize && this.estimateContext() > this.contextSize * COMPACT_AT) {
      await this.compact(signal, "auto");
    }
  }

  /**
   * Frees context in two stages: first drop old tool output, which is cheap
   * and often enough; then have the model summarize everything except the
   * most recent messages. Returns false if there was nothing to compact.
   */
  private async compact(signal: AbortSignal, reason: "auto" | "manual" | "overflow"): Promise<boolean> {
    const emit = this.opts.onEvent;
    const before = this.estimateContext();
    // Without a known window (overflow on an unknown server), assume we're just past it.
    const limit = this.contextSize ?? Math.max(4096, Math.floor(before * 0.9));
    const fixedCost = estimateTokens(this.history[0]) + estimateTokens(this.apiTools);

    const trimmed = trimOldToolResults(this.history.slice(1));
    if (reason === "auto" && trimmed.count > 0 && fixedCost + estimateTokens(trimmed.messages) < limit * TRIM_TARGET) {
      this.replaceHistory(trimmed.messages);
      emit({ type: "notice", level: "info", text: `Cleared ${trimmed.count} old tool outputs to free context (~${before.toLocaleString()} → ~${this.estimateContext().toLocaleString()} tokens).` });
      this.emitContext();
      return true;
    }

    const messages = trimmed.messages;
    const tailStart = chooseTail(messages, Math.floor(limit * TAIL_SHARE));
    const head = messages.slice(0, tailStart);
    const tail = messages.slice(tailStart);
    if (head.length === 0) {
      if (trimmed.count === 0) {
        emit({ type: "notice", level: "warn", text: "Nothing to compact: the conversation is only the latest messages." });
        return false;
      }
      this.replaceHistory(messages);
      this.emitContext();
      return true;
    }

    emit({ type: "activity", text: "Summarizing the conversation to free context…" });
    const maxChars = Math.max(8_000, Math.floor((limit - fixedCost - 4_096) * CHARS_PER_TOKEN * 0.8));
    const summary = await this.summarize(head, maxChars, signal);
    const intro = SUMMARY_PREFIX + summary;

    // Keep user/assistant alternation: some chat templates reject two user messages in a row.
    const first = tail[0];
    const next: Message[] =
      first?.role === "user"
        ? [{ role: "user", content: `${intro}\n\n---\n\n${messageText(first)}` }, ...tail.slice(1)]
        : [{ role: "user", content: tail.length ? intro : `${intro}\n\nContinue the task from where it left off.` }, ...tail];
    this.replaceHistory(next);
    // Turn boundaries no longer exist in the summarized history.
    const hadUndo = this.turns.length > 0;
    this.turns = [];

    const undoNote = hadUndo ? " Earlier turns can no longer be undone." : "";
    emit({ type: "notice", level: "info", text: `Summarized ${head.length} earlier messages (~${before.toLocaleString()} → ~${this.estimateContext().toLocaleString()} tokens).${undoNote}` });
    this.emitContext();
    return true;
  }

  private async summarize(messages: Message[], maxChars: number, signal: AbortSignal): Promise<string> {
    const { temperature } = this.opts;
    const response = await this.client.chat.completions.create(
      {
        model: this.modelId,
        // A summary doesn't need deep thought; keep it quick unless the user opted out of reasoning settings.
        ...reasoningParams(this.reasoningLevel === "default" || this.reasoningLevel === "off" ? this.reasoningLevel : "low"),
        messages: [
          { role: "system", content: SUMMARY_INSTRUCTIONS },
          { role: "user", content: `Conversation to summarize:\n\n${renderTranscript(messages, maxChars)}` },
        ],
        ...(temperature !== undefined && { temperature }),
      },
      { signal },
    );
    const summary = stripThinkTags(response.choices[0]?.message.content ?? "");
    if (!summary) throw new Error("The model returned an empty summary; the conversation was not compacted.");
    return summary;
  }

  // ---- history bookkeeping ----

  private append(message: Message): void {
    this.history.push(message);
    this.opts.onHistory?.({ type: "append", message });
  }

  private replaceHistory(messages: Message[]): void {
    this.history.splice(1, this.history.length, ...messages);
    this.measured = null;
    this.opts.onHistory?.({ type: "replace", messages });
  }

  // ---- model calls ----

  private async streamResponse(signal: AbortSignal): Promise<StreamedResponse> {
    const { temperature, onEvent: emit } = this.opts;
    const stream = await this.client.chat.completions.create(
      {
        model: this.modelId,
        ...reasoningParams(this.reasoningLevel),
        messages: this.history,
        tools: this.apiTools,
        stream: true,
        stream_options: { include_usage: true },
        // Lets the model ask for several tools at once; llama.cpp only allows
        // one per response unless asked.
        parallel_tool_calls: true,
        ...(temperature !== undefined && { temperature }),
      },
      { signal },
    );

    const result: StreamedResponse = { text: "", reasoning: "", toolCalls: [], finishReason: null, totalTokens: null };
    const calls: ToolCall[] = [];
    const thinkTags = new ThinkTagParser();
    const output = (kind: "text" | "reasoning", text: string) => {
      if (kind === "text") result.text += text;
      else result.reasoning += text;
      emit({ type: "delta", kind, text });
    };

    for await (const chunk of stream) {
      if (chunk.usage) result.totalTokens = chunk.usage.prompt_tokens + chunk.usage.completion_tokens;
      const choice = chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta as DeltaWithReasoning;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) output("reasoning", reasoning);
      // Servers that don't separate reasoning leave <think> tags in the content.
      if (delta.content) for (const seg of thinkTags.push(delta.content)) output(seg.kind, seg.text);

      // Tool calls arrive in fragments keyed by index: the first fragment
      // carries the id and name, later ones append to the JSON arguments.
      for (const fragment of delta.tool_calls ?? []) {
        const slot = (calls[fragment.index ?? 0] ??= { id: "", name: "", args: "" });
        if (fragment.id) slot.id = fragment.id;
        if (fragment.function?.name) {
          if (!slot.name) emit({ type: "tool_prepare", name: fragment.function.name });
          slot.name += fragment.function.name;
        }
        if (fragment.function?.arguments) slot.args += fragment.function.arguments;
      }
      if (choice.finish_reason) result.finishReason = choice.finish_reason;
    }
    for (const seg of thinkTags.flush()) output(seg.kind, seg.text);

    // Some local servers omit tool-call ids; the protocol needs them to pair results.
    result.toolCalls = calls
      .filter((c): c is ToolCall => c !== undefined && c.name !== "")
      .map((c) => ({ ...c, id: c.id || `call_${randomUUID()}` }));
    return result;
  }

  private assistantMessage(response: StreamedResponse): AssistantMessage {
    const text = response.text.trim();
    if (response.toolCalls.length === 0) return { role: "assistant", content: text };
    const message: AssistantMessage = {
      role: "assistant",
      content: text || null,
      tool_calls: response.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.args || "{}" },
      })),
    };
    // Models such as gpt-oss need their reasoning replayed between tool calls;
    // llama.cpp reads it from this field, and chat templates that don't use it drop it.
    if (response.reasoning) Object.assign(message, { reasoning_content: response.reasoning });
    return message;
  }

  // ---- tools ----

  private async runTool(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    const emit = this.opts.onEvent;
    const tool = this.toolsByName.get(call.name);
    const fail = (content: string, summary = ""): ToolResult => {
      emit({ type: "tool_end", id: call.id, name: call.name, summary, output: content, isError: true });
      return { content, isError: true };
    };

    if (!tool) {
      return fail(`Unknown tool "${call.name}". Available tools: ${[...this.toolsByName.keys()].join(", ")}.`);
    }

    let raw: unknown;
    try {
      raw = call.args.trim() ? JSON.parse(call.args) : {};
    } catch {
      return fail(`The arguments were not valid JSON: ${truncate(call.args, 500)}`);
    }
    const parsed = tool.schema.safeParse(raw);
    if (!parsed.success) return fail(`Invalid arguments:\n${z.prettifyError(parsed.error)}`);

    const input = parsed.data;
    const summary = tool.summarize(input);

    const ctx = this.toolContext(tool, signal);
    const reason = tool.readOnly ? await tool.approvalReason?.(input, ctx).catch(() => undefined) : undefined;
    if ((!tool.readOnly || reason) && !this.alwaysAllowed.has(tool.name)) {
      // Show the change in the prompt; a call that would fail anyway fails without asking.
      let preview: DiffLine[] | undefined;
      try {
        preview = await tool.preview?.(input, ctx);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err), summary);
      }
      const sandbox = this.opts.sandbox ?? Sandbox.none();
      const decision = await this.requestApproval({
        tool: tool.name,
        summary,
        input,
        preview,
        note: reason,
        sandbox: tool.sandboxed ? { active: sandbox.active, description: sandbox.describe() } : undefined,
      });
      if (decision === "deny" || signal.aborted) {
        return fail("The user declined this tool call. Ask them how they want to proceed.", summary);
      }
      if (decision === "allow_always") this.alwaysAllowed.add(tool.name);
    }

    emit({ type: "tool_start", id: call.id, name: tool.name, summary });
    let result: ToolResult;
    try {
      result = await tool.run(input, ctx);
    } catch (err) {
      result = { content: err instanceof Error ? err.message : String(err), isError: true };
    }
    emit({
      type: "tool_end",
      id: call.id,
      name: tool.name,
      summary,
      output: result.content,
      isError: result.isError ?? false,
      diff: result.diff,
    });
    return result;
  }

  /**
   * Asks the user, one request at a time. A request that waited may no
   * longer need asking: an earlier answer can have been "always allow".
   */
  private requestApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
    const decision = this.approvals.then(() => (this.alwaysAllowed.has(req.tool) ? "allow" : this.opts.approve(req)));
    this.approvals = decision.catch(() => {});
    return decision;
  }

  private toolContext(tool: ToolDef, signal: AbortSignal) {
    const checkpoint = this.turns[this.turns.length - 1]?.checkpoint;
    // Tools that change things without reporting what (bash) can't be undone.
    if (checkpoint && !tool.readOnly && !tool.preview) checkpoint.untracked.add(tool.name);
    return {
      cwd: this.opts.cwd,
      signal,
      sandbox: this.opts.sandbox,
      beforeWrite: (file: string) => checkpoint?.beforeWrite(file) ?? Promise.resolve(),
      afterWrite: (file: string, content: string) => checkpoint?.afterWrite(file, content),
    };
  }
}
