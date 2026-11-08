import { z } from "zod";
import type { Message } from "../history.js";
import { defineTool, type ToolDef } from "../tool.js";

export const TODO_STATUSES = ["pending", "in_progress", "completed"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
  content: string;
  status: TodoStatus;
}

const todoSchema = z.object({
  todos: z
    .array(
      z.object({
        content: z.string().min(1).describe("The step, as a short imperative sentence"),
        status: z.enum(TODO_STATUSES),
      }),
    )
    .describe("The whole list, every time: steps left out are removed"),
});

export const TODO_TOOL = "todo_write";

/** "2/5 done", for summaries. */
export function todoProgress(todos: readonly Todo[]): string {
  return `${todos.filter((t) => t.status === "completed").length}/${todos.length} done`;
}

export function unfinished(todos: readonly Todo[]): Todo[] {
  return todos.filter((t) => t.status !== "completed");
}

/** The list as plain text, for the model. */
export function formatTodos(todos: readonly Todo[]): string {
  const mark: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
  return todos.map((t) => `${mark[t.status]} ${t.content}`).join("\n");
}

/**
 * The `todo_write` tool: the model keeps a checklist for a multi-step task
 * and rewrites it as it goes. It changes no files; `onUpdate` gets the new
 * list (the agent keeps it and shows it).
 */
export function createTodoTool(onUpdate: (todos: Todo[]) => void): ToolDef {
  return defineTool({
    name: TODO_TOOL,
    description:
      "Keep a checklist for a task with several steps. Write it before you start (all pending, or the first " +
      "in_progress), and write it again whenever a step starts or finishes: mark a step completed as soon as " +
      "it's done and the next one in_progress, one at a time. Send the whole list every time. Skip it for " +
      "a task you can do in one or two steps.",
    schema: todoSchema,
    readOnly: true,
    summarize: ({ todos }) => todoProgress(todos),
    async run({ todos }) {
      onUpdate(todos);
      if (todos.length === 0) return { content: "The todo list is now empty." };
      const left = unfinished(todos).length;
      const next = left ? `${left} step${left === 1 ? "" : "s"} left. Carry on with the one in progress.` : "Every step is done.";
      return { content: `Todo list updated (${todoProgress(todos)}):\n${formatTodos(todos)}\n\n${next}` };
    },
  });
}

/** The list from the last successful todo_write in a conversation, e.g. a resumed one. */
export function todosFromHistory(messages: readonly Message[]): Todo[] {
  const failed = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && typeof m.content === "string" && m.content.startsWith("Error: ")) failed.add(m.tool_call_id);
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role !== "assistant") continue;
    for (const call of [...(m.tool_calls ?? [])].reverse()) {
      if (call.type !== "function" || call.function.name !== TODO_TOOL || failed.has(call.id)) continue;
      const parsed = parseTodos(call.function.arguments);
      if (parsed) return parsed;
    }
  }
  return [];
}

/** The todos in a todo_write call's arguments, or null if they aren't valid. */
export function parseTodos(args: string): Todo[] | null {
  try {
    const parsed = todoSchema.safeParse(JSON.parse(args || "{}"));
    return parsed.success ? parsed.data.todos : null;
  } catch {
    return null;
  }
}
