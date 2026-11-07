import type OpenAI from "openai";
import type { Agent, ApprovalDecision, ApprovalRequest } from "../core/agent.js";
import type { Endpoint, Theme } from "../core/config.js";
import type { AgentEvent } from "../core/events.js";
import type { Message } from "../core/history.js";
import type { ReasoningLevel } from "../core/reasoning.js";
import type { Sandbox } from "../core/sandbox.js";
import type { Server } from "../core/server.js";
import type { SessionInfo } from "../core/session.js";
import type { ToolDef } from "../core/tool.js";
import type { Picker } from "../tui/picker.js";
import type { Entry } from "./entries.js";

export interface AgentHooks {
  onEvent: (event: AgentEvent) => void;
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface PreferenceUpdate {
  server: Server;
  model?: string;
  reasoning?: ReasoningLevel;
}

/** Lets the UI list, open and start sessions; the CLI owns which one is recorded to. */
export interface SessionControl {
  currentId(): string;
  /** The name given with /name, if any. */
  currentName(): string | undefined;
  /** This folder's sessions (or every folder's), newest first. */
  list(everywhere?: boolean): SessionInfo[];
  /** Makes `id` the session being recorded and returns its conversation, folder, last model and when it was last used. */
  open(id: string): { messages: Message[]; model: string; endpoint?: string; cwd: string; lastUsed?: Date };
  /** Names the current session. */
  rename(name: string): void;
  /** Starts recording to a new session (its file appears with the first message). */
  startNew(model: string, endpoint: string | undefined): void;
  /** Folders with saved sessions, most recently used first. */
  recentProjects(): { cwd: string; sessions: number; updated: Date }[];
}

/** Settings carried over when the agent is recreated for another project. */
export interface AgentSettings {
  client: OpenAI;
  model: string;
  reasoning: ReasoningLevel;
  contextSize: number | undefined;
}

/** The folder being worked in, and what was loaded for it. */
export interface ProjectView {
  cwd: string;
  /** Instruction files in use, for the banner. */
  instructions: string[];
  /** Skills available, for the banner and /skills. */
  skills: { name: string; description: string }[];
  tools: ToolDef[];
  /** Problems found while loading (e.g. a skill without a description). */
  warnings: string[];
}

export interface TuiOptions {
  /** Creates the agent for the current project; with `current`, carrying over those settings. */
  createAgent: (hooks: AgentHooks, current?: AgentSettings) => Agent;
  project: ProjectView;
  /** Makes another folder the project (/new <folder>). Throws if it isn't a folder. */
  switchProject: (folder: string) => ProjectView;
  /** The server the agent starts on. */
  server: Server;
  /** Endpoints from the config file, for /endpoint. */
  endpoints: Endpoint[];
  configFile: string;
  /** Problems found while loading the config, shown at startup. */
  warnings: string[];
  /** The model last used on a server, if remembered. */
  rememberedModel: (baseURL: string) => string | undefined;
  sandbox: Sandbox;
  sessions: SessionControl;
  /** Conversation restored from a saved session, shown before the prompt. */
  resumed: Message[];
  /** When the resumed session was last used, for the greeting. */
  resumedLastUsed?: Date;
  /** Remembers the user's endpoint, model and reasoning choices for next time. */
  savePreferences: (update: PreferenceUpdate) => void;
  theme: Theme;
  /** With the matrix theme: the idle stream of glyphs in the status line. */
  codeStream: boolean;
}

/**
 * The part of the app the command modules (sessions.ts, connection.ts) work
 * through: what's current, and how to show things.
 */
export interface UiContext {
  readonly opts: TuiOptions;
  readonly hooks: AgentHooks;
  agent: Agent;
  server: Server;
  project: ProjectView;
  /** Adds an entry to the transcript. */
  print(entry: Entry): void;
  /** Clears the screen and starts a fresh transcript: a new session, or a resumed one last used at `lastUsed`. */
  startOver(start: { resumed: false } | { resumed: true; lastUsed?: Date }, entries: Entry[]): void;
  /** Shows a picker; `onPick` gets the value of the item chosen (not called on esc). */
  openPicker(picker: Picker, onPick: (value: string) => void): void;
  /** Shows a spinner while `work` runs, printing any error. */
  withActivity(activity: string, work: () => Promise<void>): Promise<void>;
  /** Fetches the server's model list again, for completing /model. */
  refreshModels(): void;
}
