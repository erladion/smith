import type OpenAI from "openai";

export type Message = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** How the conversation changed; persisted by the session log. */
export type HistoryChange = { type: "append"; message: Message } | { type: "replace"; messages: Message[] };

/** Plain text of a message's content, whether it is a string or content parts. */
export function messageText(message: Message): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!content) return "";
  return content.map((part) => ("text" in part ? part.text : "")).join("");
}

/**
 * Gives every assistant tool call a matching tool result. A session saved
 * mid-turn (crash, kill) can end with unanswered calls, which servers reject.
 */
export function repairHistory(messages: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]!;
    out.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) continue;

    const answered = new Set<string>();
    while (messages[i + 1]?.role === "tool") {
      const result = messages[++i] as OpenAI.Chat.Completions.ChatCompletionToolMessageParam;
      answered.add(result.tool_call_id);
      out.push(result);
    }
    for (const call of message.tool_calls) {
      if (!answered.has(call.id)) {
        out.push({ role: "tool", tool_call_id: call.id, content: "Error: Interrupted before this tool ran." });
      }
    }
  }
  return out;
}
