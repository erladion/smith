import type { DiffLine } from "./diff.js";
import type { Todo } from "./tools/todo.js";

// Everything the agent loop reports to the outside world. The core never
// imports UI code: a frontend (TUI, headless printer, tests) subscribes to
// these events and renders them however it likes.

export type BlockKind = "text" | "reasoning";
export type NoticeLevel = "info" | "warn" | "error";
export type DoneReason = "stop" | "interrupted" | "length" | "max_steps";

export type AgentEvent =
  /** Messages you typed while the agent worked, now handed to the model. */
  | { type: "user_message"; text: string }
  /** A streamed chunk of assistant text or reasoning. */
  | { type: "delta"; kind: BlockKind; text: string }
  /** The model finished streaming one response; flush any live text. */
  | { type: "response_end" }
  /** The model has started emitting a call to this tool (arguments still streaming). */
  | { type: "tool_prepare"; name: string }
  | { type: "tool_start"; id: string; name: string; summary: string }
  | { type: "tool_end"; id: string; name: string; summary: string; output: string; isError: boolean; diff?: DiffLine[] }
  /** How full the context window is. `limit` is unknown for servers that don't report it. */
  | { type: "context"; tokens: number; limit?: number }
  /** Background work worth showing in a status line; `compacting` while the conversation is being summarized. */
  | { type: "activity"; text: string; compacting?: boolean }
  | { type: "notice"; level: NoticeLevel; text: string }
  /** The model rewrote its checklist (todo_write), or it was cleared or restored. */
  | { type: "todos"; todos: Todo[] }
  | { type: "done"; reason: DoneReason };
