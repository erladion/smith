import os from "node:os";
import path from "node:path";
import { REASONING_HINTS, REASONING_LEVELS } from "../core/reasoning.js";
import { listFolders } from "./folders.js";

/** A slash command, as listed by /help and offered while typing. */
export interface CommandSpec {
  name: string;
  /** How its argument is written in help, e.g. "[name]" or "on|off". */
  args?: string;
  description: string;
  /** Completions for the argument, given what's typed after the command. */
  complete?: (typed: string, ctx: CompletionContext) => Completion[];
}

export interface CompletionContext {
  cwd: string;
  endpoints: string[];
  models: string[];
}

export interface Completion {
  value: string;
  hint?: string;
}

const fixed = (items: Completion[]) => (typed: string) => items.filter((i) => i.value.startsWith(typed));

export const COMMANDS: CommandSpec[] = [
  { name: "/help", description: "show the commands and keys" },
  {
    name: "/endpoint",
    args: "[name]",
    description: "pick a configured endpoint, or switch to one by name",
    complete: (typed, ctx) => ctx.endpoints.filter((e) => e.startsWith(typed)).map((value) => ({ value })),
  },
  {
    name: "/model",
    args: "[name]",
    description: "pick a model from the server, or switch to one by name",
    complete: (typed, ctx) => ctx.models.filter((m) => m.toLowerCase().includes(typed.toLowerCase())).map((value) => ({ value })),
  },
  {
    name: "/reasoning",
    args: "[level]",
    description: `pick how much the model thinks: ${REASONING_LEVELS.join(", ")}`,
    complete: fixed(REASONING_LEVELS.map((value) => ({ value, hint: REASONING_HINTS[value] }))),
  },
  {
    name: "/sessions",
    args: "[all]",
    description: "switch to another session from this folder (all: from every folder)",
    complete: fixed([{ value: "all", hint: "sessions from every folder" }]),
  },
  { name: "/name", args: "[name]", description: "show or set the current session's name" },
  { name: "/open", description: "pick a project folder: a recent one, or browse to one" },
  {
    name: "/new",
    args: "[folder]",
    description: "start a new session, here or in another folder",
    complete: (typed, ctx) => completeFolder(typed, ctx.cwd),
  },
  { name: "/clear", description: "start a new session (same as /new)" },
  { name: "/undo", description: "undo the last turn: restore files it changed and edit your message again" },
  { name: "/skills", description: "list the available skills" },
  {
    name: "/network",
    args: "on|off",
    description: "allow or block network access for sandboxed commands",
    complete: fixed([
      { value: "on", hint: "allow network access" },
      { value: "off", hint: "block network access" },
    ]),
  },
  { name: "/compact", description: "summarize the conversation now to free context" },
  { name: "/exit", description: "quit" },
];

export function helpText(): string {
  const width = Math.max(...COMMANDS.map((c) => `${c.name} ${c.args ?? ""}`.length)) + 2;
  const lines = COMMANDS.map((c) => `  ${`${c.name} ${c.args ?? ""}`.padEnd(width)}${c.description}`);
  return `Commands (type / to see them as you type; tab completes, enter runs):
${lines.join("\n")}
Keys: enter sends · shift+enter, \\ then enter, or ctrl+j adds a new line · esc interrupts the agent
      ↑/↓ recall earlier input · ctrl+c quits`;
}

/** One entry of the suggestion list: `text` is what the input becomes when it's chosen. */
export interface Suggestion {
  text: string;
  label: string;
  hint?: string;
  /** Whether choosing it should leave the input open for an argument rather than run it. */
  takesArgument: boolean;
}

/**
 * Suggestions for what's typed so far: command names while typing the
 * command ("/h" → /help), then the argument's completions once a space
 * follows a command that has them ("/reasoning h" → high).
 */
export function suggest(input: string, ctx: CompletionContext): Suggestion[] {
  if (!input.startsWith("/") || input.includes("\n")) return [];
  const space = input.indexOf(" ");

  if (space === -1) {
    const typed = input.toLowerCase();
    const starts = COMMANDS.filter((c) => c.name.startsWith(typed));
    const contains = COMMANDS.filter((c) => !c.name.startsWith(typed) && c.name.includes(typed.slice(1)));
    return [...starts, ...contains].map((c) => ({
      text: c.name,
      label: c.args ? `${c.name} ${c.args}` : c.name,
      hint: c.description,
      takesArgument: false,
    }));
  }

  const command = COMMANDS.find((c) => c.name === input.slice(0, space));
  if (!command?.complete) return [];
  const typed = input.slice(space + 1);
  return command.complete(typed, ctx).map((c) => ({
    text: `${command.name} ${c.value}`,
    label: c.value,
    hint: c.hint,
    // A folder can be gone into further; other arguments are complete.
    takesArgument: c.value.endsWith("/"),
  }));
}

/** Folder completions for a partly typed path, relative to `cwd`, absolute, or with ~/. */
function completeFolder(typed: string, cwd: string): Completion[] {
  const slash = typed.lastIndexOf("/");
  const dirPart = slash === -1 ? "" : typed.slice(0, slash + 1);
  const prefix = slash === -1 ? typed : typed.slice(slash + 1);
  const expanded = dirPart.startsWith("~/") || dirPart === "~" ? path.join(os.homedir(), dirPart.slice(1)) : dirPart;
  const base = path.resolve(cwd, expanded || ".");
  const showHidden = prefix.startsWith(".");
  return listFolders(base, showHidden)
    .names.filter((name) => name.startsWith(prefix))
    .slice(0, 50)
    .map((name) => ({ value: `${dirPart}${name}/` }));
}
