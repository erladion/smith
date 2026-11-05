import OpenAI from "openai";
import { type Message, messageText } from "./history.js";
import { truncate } from "./tool.js";

// Rough but serviceable for code and English across common tokenizers. Real
// counts come from the server's usage reports; this only fills the gaps.
export const CHARS_PER_TOKEN = 3.5;

export const SUMMARY_PREFIX = "[Summary of the earlier conversation, written when the context window filled up]\n\n";
const TRIMMED_NOTE = "[Old tool output removed to save context. Run the tool again if you need it.]";

export const SUMMARY_INSTRUCTIONS = `You are summarizing a conversation between a user and a coding agent so the agent can continue the work with a fresh context window. The agent will see only your summary plus the most recent messages.

Write a concise summary covering:
- The user's goal and any requirements or preferences they stated.
- What has been done so far: files read, created or changed (with paths), commands run and their important results.
- Decisions made and why, including approaches that were tried and failed.
- The current state of the work and the immediate next step.

Keep exact file paths, function names, error messages and values that the agent may need. Leave out pleasantries and anything that no longer matters. Use plain text with short bullet points.`;

export function estimateTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Replaces the content of older tool results with a short note. Tool output
 * is usually the bulk of the context and the cheapest thing to drop: the
 * model can re-run a tool if it needs the output again.
 */
export function trimOldToolResults(messages: Message[], keepRecent = 3, minChars = 400): { messages: Message[]; count: number } {
  const toolIndexes = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const trimmable = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent)));
  let count = 0;
  const out = messages.map((m, i) => {
    if (!trimmable.has(i) || m.role !== "tool") return m;
    const text = messageText(m);
    if (text.length < minChars || text === TRIMMED_NOTE) return m;
    count++;
    return { ...m, content: TRIMMED_NOTE };
  });
  return { messages: out, count };
}

/**
 * Picks where the kept "tail" of the conversation starts: the earliest
 * user or assistant message whose suffix fits in `budgetTokens`. Starting
 * there (never on a tool message) keeps every tool call paired with its result.
 */
export function chooseTail(messages: Message[], budgetTokens: number): number {
  let start = messages.length;
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    used += estimateTokens(messages[i]);
    if (used > budgetTokens) break;
    if (messages[i]!.role !== "tool") start = i;
  }
  return start;
}

/** Renders messages as a plain-text transcript for the summarizer, capped at `maxChars`. */
export function renderTranscript(messages: Message[], maxChars: number): string {
  const parts: string[] = [];
  for (const m of messages) {
    const text = messageText(m);
    switch (m.role) {
      case "user":
        parts.push(`USER:\n${truncate(text, 6_000)}`);
        break;
      case "assistant": {
        if (text) parts.push(`ASSISTANT:\n${truncate(text, 6_000)}`);
        for (const call of m.tool_calls ?? []) {
          if (call.type === "function") {
            parts.push(`ASSISTANT CALLED ${call.function.name}(${truncate(call.function.arguments, 1_500)})`);
          }
        }
        break;
      }
      case "tool":
        parts.push(`TOOL RESULT:\n${truncate(text, 2_000)}`);
        break;
      default:
        break;
    }
  }
  return truncate(parts.join("\n\n"), maxChars);
}

/**
 * Recognizes "prompt too long" errors from llama.cpp, vLLM and OpenAI.
 * Returns null for other errors, and the server's context size when it says.
 */
export function contextOverflow(err: unknown): { contextSize?: number } | null {
  if (!(err instanceof OpenAI.APIError)) return null;
  const body = (err.error ?? {}) as Record<string, unknown>;
  const text = `${err.message} ${JSON.stringify(body)}`;
  const matches =
    err.code === "context_length_exceeded" ||
    /exceed_context_size|exceeds the available context|maximum context length|context (length|window) exceeded|prompt is too long/i.test(text);
  if (!matches) return null;
  return { contextSize: typeof body.n_ctx === "number" ? body.n_ctx : undefined };
}
