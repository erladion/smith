import { SUMMARY_PREFIX } from "../core/context.js";
import { type Message, messageText } from "../core/history.js";
import { describeCall, type ToolDef } from "../core/tool.js";
import type { Entry } from "./entries.js";

/** Rebuilds transcript entries from a saved conversation, so a resumed session shows its history. */
export function historyToEntries(messages: readonly Message[], tools: ToolDef[]): Entry[] {
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool") results.set(m.tool_call_id, messageText(m));

  const entries: Entry[] = [];
  for (const m of messages) {
    if (m.role === "user") {
      const text = messageText(m);
      if (text.startsWith(SUMMARY_PREFIX)) {
        entries.push({ kind: "notice", level: "info", text: "(Earlier conversation was summarized to save context.)" });
        const sep = text.indexOf("\n\n---\n\n");
        if (sep !== -1) entries.push({ kind: "user", text: text.slice(sep + 7) });
      } else {
        entries.push({ kind: "user", text });
      }
    } else if (m.role === "assistant") {
      const text = messageText(m).trim();
      if (text) entries.push({ kind: "text", text });
      for (const call of m.tool_calls ?? []) {
        if (call.type !== "function") continue;
        const output = results.get(call.id) ?? "";
        const isError = output.startsWith("Error: ");
        entries.push({
          kind: "tool",
          name: call.function.name,
          summary: describeCall(tools, call.function.name, call.function.arguments),
          output: isError ? output.slice(7) : output,
          isError,
        });
      }
    }
  }
  return entries;
}
