import type { Agent, ApprovalDecision, ApprovalRequest } from "../core/agent.js";
import { type Endpoint, EXAMPLE_CONFIG } from "../core/config.js";
import { describeError } from "../core/errors.js";
import type { AgentEvent, BlockKind } from "../core/events.js";
import type { Message } from "../core/history.js";
import { isReasoningLevel, REASONING_HINTS, REASONING_LEVELS, type ReasoningLevel } from "../core/reasoning.js";
import type { Sandbox } from "../core/sandbox.js";
import { Server } from "../core/server.js";
import type { ToolDef } from "../core/tool.js";
import { LineEditor } from "./editor.js";
import { box, DIM, diffView, type Entry, entryLines, REASONING } from "./entries.js";
import { type Key, KeyReader } from "./keys.js";
import { markdownLines, safeSplit } from "./markdown.js";
import { Picker } from "./picker.js";
import { InlineRenderer } from "./renderer.js";
import { historyToEntries } from "./replay.js";
import type { Line } from "./style.js";
import { prefixed, truncate, wrap } from "./text.js";

export interface AgentHooks {
  onEvent: (event: AgentEvent) => void;
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface PreferenceUpdate {
  server: Server;
  model?: string;
  reasoning?: ReasoningLevel;
}

export interface TuiOptions {
  createAgent: (hooks: AgentHooks) => Agent;
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
  cwd: string;
  sessionId: string;
  /** Conversation restored from a saved session, shown before the prompt. */
  resumed: Message[];
  tools: ToolDef[];
  /** Instruction files in use, for the banner. */
  instructions: string[];
  /** Skills available, by name and description, for the banner and /skills. */
  skills: { name: string; description: string }[];
  /** Remembers the user's endpoint, model and reasoning choices for next time. */
  savePreferences: (update: PreferenceUpdate) => void;
}

interface Terminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

const HELP = `Commands:
  /endpoint [name]    pick a configured endpoint, or switch to one by name
  /model [name]       pick a model from the server, or switch to one by name
  /reasoning [level]  pick how much the model thinks: ${REASONING_LEVELS.join(", ")}
  /undo               undo the last turn: restore files it changed and edit your message again
  /skills             list the available skills
  /network on|off     allow or block network access for sandboxed commands
  /compact            summarize the conversation now to free context
  /clear              start the conversation over
  /exit               quit
Keys: enter sends · shift+enter, \\ then enter, or ctrl+j adds a new line · esc interrupts the agent
      ↑/↓ recall earlier input · ctrl+c quits`;

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** The interactive terminal UI: a transcript above, a live region below. */
export class TuiApp {
  private readonly renderer: InlineRenderer;
  private readonly keys = new KeyReader();
  private readonly editor = new LineEditor();
  private readonly agent: Agent;
  private server: Server;

  private live: { kind: BlockKind; text: string } | null = null;
  private activity: string | null = null;
  private approval: (ApprovalRequest & { resolve: (d: ApprovalDecision) => void }) | null = null;
  private picker: { kind: "endpoint" | "model" | "reasoning"; picker: Picker } | null = null;
  private busy = false;
  private abort: AbortController | null = null;
  private context: { tokens: number; limit?: number } | null = null;

  /** Everything printed so far, to reprint at a new width after a resize. */
  private readonly transcript: Entry[] = [];
  private printedWidth = 0;
  private resizeTimer: NodeJS.Timeout | undefined;
  private frame = 0;
  private spinner: NodeJS.Timeout | undefined;
  private renderTimer: NodeJS.Timeout | undefined;
  private closed = false;
  private finished: () => void = () => {};

  constructor(
    private readonly opts: TuiOptions,
    private readonly term: Terminal = { input: process.stdin, output: process.stdout },
  ) {
    this.server = opts.server;
    this.renderer = new InlineRenderer(term.output);
    this.agent = opts.createAgent({ onEvent: (e) => this.onEvent(e), approve: (r) => this.approve(r) });
  }

  /** Runs until the user quits. */
  run(): Promise<void> {
    const { input, output } = this.term;
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.on("data", this.onData);
    input.resume();
    output.on("resize", this.onResize);
    // Hide the real cursor (we draw our own), turn on bracketed paste, and ask
    // for the kitty keyboard protocol so Shift+Enter is distinguishable from
    // Enter. Terminals that don't know a request ignore it.
    output.write("\x1b[?25l\x1b[?2004h\x1b[>1u");
    process.once("exit", this.restoreTerminal);

    const { sandbox, cwd, sessionId, resumed, tools } = this.opts;
    this.print({
      kind: "banner",
      model: this.agent.model,
      server: this.server.label,
      cwd,
      session: sessionId,
      resumed: resumed.length > 0,
      sandbox: { active: sandbox.active, description: sandbox.describe() },
      instructions: this.opts.instructions,
      skills: this.opts.skills.map((s) => s.name),
    });
    for (const text of this.opts.warnings) this.print({ kind: "notice", level: "warn", text });
    for (const entry of historyToEntries(resumed, tools)) this.print(entry);
    this.render();

    return new Promise((resolve) => (this.finished = resolve));
  }

  // ---- terminal plumbing ----

  private readonly onData = (data: string) => {
    for (const key of this.keys.feed(data)) {
      if (this.closed) return;
      this.onKey(key);
    }
    this.requestRender();
  };

  private readonly onResize = () => {
    clearTimeout(this.resizeTimer);
    // Wait for dragging to settle, then reprint once.
    this.resizeTimer = setTimeout(() => {
      if (this.closed) return;
      if (this.width !== this.printedWidth) {
        this.renderer.reset();
        this.printedWidth = this.width;
        for (const entry of this.transcript) this.renderer.print(entryLines(entry, this.width));
      }
      this.render();
    }, 100);
  };

  private readonly restoreTerminal = () => {
    this.term.output.write("\x1b[<u\x1b[?2004l\x1b[?25h");
    if (this.term.input.isTTY) this.term.input.setRawMode(false);
  };

  private exit(): void {
    if (this.closed) return;
    this.closed = true;
    this.abort?.abort();
    this.approval?.resolve("deny");
    clearInterval(this.spinner);
    clearTimeout(this.renderTimer);
    clearTimeout(this.resizeTimer);
    this.renderer.finish();
    this.restoreTerminal();
    process.removeListener("exit", this.restoreTerminal);
    this.term.input.removeListener("data", this.onData);
    this.term.output.removeListener("resize", this.onResize);
    this.term.input.pause();
    this.finished();
  }

  private get width(): number {
    return Math.max(20, this.term.output.columns || 80);
  }

  private print(entry: Entry): void {
    this.transcript.push(entry);
    this.printedWidth = this.width;
    this.renderer.print(entryLines(entry, this.width));
    this.requestRender();
  }

  /** Redraws soon; many events in a burst (streaming) become one redraw. */
  private requestRender(): void {
    if (this.closed || this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 16);
  }

  private render(): void {
    if (this.closed) return;
    // The spinner only needs a timer while it's on screen.
    const spinning = Boolean(this.activity && !this.approval);
    if (spinning && !this.spinner) {
      this.spinner = setInterval(() => {
        this.frame = (this.frame + 1) % SPINNER.length;
        this.requestRender();
      }, 80);
    } else if (!spinning && this.spinner) {
      clearInterval(this.spinner);
      this.spinner = undefined;
    }
    this.renderer.draw(this.liveLines());
  }

  private liveLines(): Line[] {
    const width = this.width;
    const lines: Line[] = [];
    if (this.live?.text) {
      lines.push([]);
      lines.push(...(this.live.kind === "text" ? markdownLines(this.live.text, width) : wrap([{ text: this.live.text, style: REASONING }], width)));
    }
    if (this.activity && !this.approval) {
      lines.push([], truncate([{ text: SPINNER[this.frame]!, style: { color: "yellow" } }, { text: ` ${this.activity}`, style: DIM }], width));
    }
    if (this.approval) {
      lines.push([], ...this.approvalBox(this.approval, width));
    } else if (this.picker) {
      lines.push([], ...box(this.picker.picker.lines(), "cyan", width));
    } else if (!this.busy) {
      const prompt = prefixed([{ text: "› ", style: { color: "cyan" } }], [{ text: "  " }], this.editor.render("Ask for something, or /help"), width - 4);
      lines.push([], ...box(prompt, "gray", width, true));
    }
    lines.push(this.statusLine(width));
    return lines;
  }

  private approvalBox(req: ApprovalRequest, width: number): Line[] {
    const content: Line[] = [[{ text: `Allow ${req.tool}?`, style: { bold: true } }]];
    const summary = wrap([{ text: req.summary }], width - 4);
    content.push(...summary.slice(0, 12));
    if (summary.length > 12) content.push([{ text: `… ${summary.length - 12} more lines`, style: DIM }]);
    if (req.preview) {
      // Leave room for the rest of the screen, but show as much of the change as fits.
      const room = Math.max(6, (this.term.output.rows || 24) - content.length - 10);
      content.push([], ...diffView(req.preview, width - 4, room), []);
    }
    if (req.sandbox) {
      content.push([{ text: `${req.sandbox.active ? "✓" : "⚠"} ${req.sandbox.description}`, style: { color: req.sandbox.active ? "green" : "red" } }]);
    }
    content.push([
      { text: "y", style: { color: "green" } },
      { text: " yes · ", style: DIM },
      { text: "a", style: { color: "green" } },
      { text: ` always allow ${req.tool} this session · `, style: DIM },
      { text: "n", style: { color: "red" } },
      { text: " no · ", style: DIM },
      { text: "esc", style: { color: "red" } },
      { text: " no and interrupt", style: DIM },
    ]);
    return box(content, "yellow", width, true);
  }

  private statusLine(width: number): Line {
    const k = (n: number) => (n >= 1024 ? `${Math.round(n / 1024)}k` : String(n));
    const parts = [this.server.name, this.agent.model, `reasoning ${this.agent.reasoning}`];
    if (this.context) {
      parts.push(
        this.context.limit
          ? `${Math.round((100 * this.context.tokens) / this.context.limit)}% of ${k(this.context.limit)} context`
          : `${k(this.context.tokens)} tokens`,
      );
    }
    const { sandbox } = this.opts;
    if (sandbox.active) parts.push(`sandbox, net ${sandbox.network ? "on" : "off"}`);
    if (this.busy) parts.push("esc to interrupt");
    const line: Line = sandbox.active ? [] : [{ text: "unsandboxed · ", style: { color: "red" } }];
    line.push({ text: parts.filter(Boolean).join(" · "), style: DIM });
    return truncate(line, width);
  }

  // ---- agent events ----

  private onEvent(event: AgentEvent): void {
    if (this.closed) return;
    switch (event.type) {
      case "delta":
        this.activity = null;
        this.appendDelta(event.kind, event.text);
        break;
      case "response_end":
        this.flushLive();
        break;
      case "tool_prepare":
        this.flushLive();
        this.activity = `Preparing ${event.name}…`;
        break;
      case "tool_start":
        this.activity = `${event.name} ${event.summary}`;
        break;
      case "tool_end":
        this.activity = "Thinking…";
        this.print({ kind: "tool", name: event.name, summary: event.summary, output: event.output, isError: event.isError, diff: event.diff });
        break;
      case "context":
        this.context = { tokens: event.tokens, limit: event.limit };
        break;
      case "activity":
        this.activity = event.text;
        break;
      case "notice":
        this.flushLive();
        this.print({ kind: "notice", level: event.level, text: event.text });
        break;
      case "done":
        if (event.reason === "interrupted") this.print({ kind: "notice", level: "warn", text: "Interrupted." });
        break;
    }
    this.requestRender();
  }

  /**
   * Streamed text stays in the live region until a paragraph is complete;
   * then it is printed for good, so the part being redrawn stays small.
   */
  private appendDelta(kind: BlockKind, text: string): void {
    if (this.live && this.live.kind !== kind) this.flushLive();
    let next = this.live ? this.live.text + text : text.replace(/^\s+/, "");
    const cut = safeSplit(next);
    if (cut > 0) {
      this.print({ kind, text: next.slice(0, cut).trimEnd() });
      next = next.slice(cut).replace(/^\n+/, "");
    }
    this.live = { kind, text: next };
  }

  private flushLive(): void {
    if (this.live?.text.trim()) this.print({ kind: this.live.kind, text: this.live.text.trimEnd() });
    this.live = null;
  }

  private approve(req: ApprovalRequest): Promise<ApprovalDecision> {
    return new Promise((resolve) => {
      this.approval = { ...req, resolve };
      this.requestRender();
    });
  }

  private decide(decision: ApprovalDecision): void {
    const pending = this.approval;
    this.approval = null;
    pending?.resolve(decision);
  }

  // ---- keys ----

  private onKey(key: Key): void {
    if (key.name === "char" && key.ctrl && key.text === "c") return this.exit();

    if (this.approval) {
      const letter = key.name === "text" ? key.text?.toLowerCase() : undefined;
      if (letter === "y") this.decide("allow");
      else if (letter === "a") this.decide("allow_always");
      else if (letter === "n") this.decide("deny");
      else if (key.name === "escape") {
        this.decide("deny");
        this.abort?.abort();
      }
      return;
    }

    if (this.picker) {
      const result = this.picker.picker.handle(key);
      if (result === "cancel") this.picker = null;
      else if (result) this.onPick(result.value);
      return;
    }

    if (this.busy) {
      if (key.name === "escape") this.abort?.abort();
      return;
    }

    if (key.name === "char" && key.ctrl && key.text === "d" && !this.editor.value) return this.exit();
    if (this.editor.handle(key) === "submit") void this.submit(this.editor.commit());
  }

  // ---- commands ----

  private async submit(value: string): Promise<void> {
    const text = value.trim();
    if (!text) return;

    if (text.startsWith("/")) {
      const [command, ...rest] = text.split(/\s+/);
      const arg = rest.join(" ");
      switch (command) {
        case "/exit":
        case "/quit":
          return this.exit();
        case "/help":
          return this.print({ kind: "notice", level: "info", text: HELP });
        case "/clear":
          this.agent.reset();
          this.context = null;
          return this.print({ kind: "notice", level: "info", text: "Conversation cleared." });
        case "/network":
          return this.setNetwork(arg);
        case "/undo":
          return this.undo();
        case "/skills":
          return this.listSkills();
        case "/compact":
          return this.runBusy("Compacting…", (signal) => this.agent.compactNow(signal));
        case "/endpoint":
          return arg ? this.switchEndpoint(arg) : this.openEndpointPicker();
        case "/model":
          return arg ? this.switchModel(arg) : this.openModelPicker();
        case "/reasoning":
          if (!arg) return this.openReasoningPicker();
          if (isReasoningLevel(arg)) return this.switchReasoning(arg);
          return this.print({ kind: "notice", level: "error", text: `Unknown reasoning level "${arg}". Use one of: ${REASONING_LEVELS.join(", ")}.` });
        default:
          return this.print({ kind: "notice", level: "error", text: `Unknown command ${command}. Type /help for the list.` });
      }
    }

    this.print({ kind: "user", text });
    await this.runBusy("Thinking…", (signal) => this.agent.send(text, signal));
  }

  /** Runs agent work with the spinner on and esc wired to interrupt it. */
  private async runBusy(activity: string, work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const controller = new AbortController();
    this.abort = controller;
    this.busy = true;
    this.activity = activity;
    this.requestRender();
    try {
      await work(controller.signal);
    } catch (err) {
      this.flushLive();
      this.print({ kind: "notice", level: "error", text: describeError(err, this.server.baseURL) });
    } finally {
      this.flushLive();
      this.abort = null;
      this.activity = null;
      this.busy = false;
      this.requestRender();
    }
  }

  /** Shows a spinner while `work` runs, without making it interruptible. */
  private async withActivity(activity: string, work: () => Promise<void>): Promise<void> {
    this.busy = true;
    this.activity = activity;
    this.requestRender();
    try {
      await work();
    } catch (err) {
      this.print({ kind: "notice", level: "error", text: describeError(err, this.server.baseURL) });
    } finally {
      this.activity = null;
      this.busy = false;
      this.requestRender();
    }
  }

  private async undo(): Promise<void> {
    const result = await this.agent.undo();
    if (!result) return this.print({ kind: "notice", level: "info", text: "Nothing to undo." });
    const rel = (f: string) => f.startsWith(this.opts.cwd + "/") ? f.slice(this.opts.cwd.length + 1) : f;
    const lines = ["Undid the last turn and removed it from the conversation."];
    if (result.restored.length) lines.push(`Restored: ${result.restored.map(rel).join(", ")}`);
    if (result.skipped.length) lines.push(`Left alone because they changed afterwards: ${result.skipped.map(rel).join(", ")}`);
    if (result.untracked.length) lines.push(`Not undone: anything changed by ${result.untracked.join(", ")} commands.`);
    this.print({ kind: "notice", level: result.skipped.length || result.untracked.length ? "warn" : "info", text: lines.join("\n") });
    this.editor.setValue(result.prompt);
  }

  private listSkills(): void {
    const { skills } = this.opts;
    if (skills.length === 0) {
      return this.print({ kind: "notice", level: "info", text: "No skills found. Add folders with a SKILL.md to .agents/skills/ in the project or ~/.config/agent/skills/." });
    }
    this.print({ kind: "notice", level: "info", text: skills.map((s) => `${s.name}: ${s.description.replace(/\s+/g, " ")}`).join("\n") });
  }

  private setNetwork(arg: string): void {
    const { sandbox } = this.opts;
    if (!sandbox.active) {
      return this.print({ kind: "notice", level: "warn", text: `There is no sandbox, so commands already have full network access (${sandbox.reason}).` });
    }
    if (arg !== "on" && arg !== "off") {
      return this.print({ kind: "notice", level: "info", text: `Network is ${sandbox.network ? "on" : "off"} for sandboxed commands. Use /network on or /network off.` });
    }
    sandbox.network = arg === "on";
    this.print({ kind: "notice", level: "info", text: `Sandboxed commands now have network ${arg}.` });
  }

  private onPick(value: string): void {
    const open = this.picker;
    this.picker = null;
    if (open?.kind === "endpoint" && value !== this.server.name) void this.switchEndpoint(value);
    if (open?.kind === "model" && value !== this.agent.model) void this.switchModel(value);
    if (open?.kind === "reasoning" && isReasoningLevel(value) && value !== this.agent.reasoning) this.switchReasoning(value);
  }

  private switchModel(id: string): Promise<void> {
    return this.withActivity(`Checking ${id}…`, async () => {
      const contextSize = await this.server.contextSize(id);
      this.agent.setModel(id, contextSize);
      this.opts.savePreferences({ server: this.server, model: id });
      const window = contextSize ? `${contextSize.toLocaleString()}-token context` : "context size unknown";
      this.print({ kind: "notice", level: "info", text: `Switched to ${id} (${window}).` });
    });
  }

  private switchReasoning(level: ReasoningLevel): void {
    this.agent.setReasoning(level);
    this.opts.savePreferences({ server: this.server, reasoning: level });
    this.print({ kind: "notice", level: "info", text: `Reasoning: ${level} (${REASONING_HINTS[level]}).` });
  }

  private switchEndpoint(name: string): Promise<void> {
    const endpoint = this.opts.endpoints.find((e) => e.name === name);
    if (!endpoint) {
      const known = this.opts.endpoints.map((e) => e.name).join(", ") || "none";
      this.print({ kind: "notice", level: "error", text: `Unknown endpoint "${name}". Configured: ${known}.` });
      return Promise.resolve();
    }
    return this.withActivity(`Connecting to ${name}…`, async () => {
      const next = Server.fromEndpoint(endpoint);
      const model = await next.chooseModel([this.opts.rememberedModel(next.baseURL)]);
      const contextSize = await next.contextSize(model);
      this.agent.setModel(model, contextSize, next.client);
      this.server = next;
      this.opts.savePreferences({ server: next, model });
      const window = contextSize ? `${contextSize.toLocaleString()}-token context` : "context size unknown";
      this.print({ kind: "notice", level: "info", text: `Connected to ${next.label}, using ${model} (${window}).` });
    });
  }

  private openEndpointPicker(): void {
    const { endpoints, configFile } = this.opts;
    if (endpoints.length === 0) {
      return this.print({ kind: "notice", level: "info", text: `No endpoints are configured. Add them to ${configFile}, for example:\n${EXAMPLE_CONFIG}` });
    }
    const items = endpoints.map((e) => ({ value: e.name, label: e.name, hint: e.model ? `${e.baseURL} · ${e.model}` : e.baseURL }));
    this.picker = { kind: "endpoint", picker: new Picker("Select an endpoint", items, this.server.name) };
  }

  private openModelPicker(): Promise<void> {
    return this.withActivity("Loading models…", async () => {
      const models = await this.server.listModels(true);
      if (models.length === 0) {
        return this.print({ kind: "notice", level: "warn", text: "The server lists no models. Use /model <name> to set one directly." });
      }
      const items = models.map((m) => ({ value: m.id, label: m.id, hint: m.contextSize ? `${m.contextSize.toLocaleString()} ctx` : undefined }));
      this.picker = { kind: "model", picker: new Picker("Select a model", items, this.agent.model) };
    });
  }

  private openReasoningPicker(): void {
    const items = REASONING_LEVELS.map((l) => ({ value: l, label: l, hint: REASONING_HINTS[l] }));
    this.picker = { kind: "reasoning", picker: new Picker("Select reasoning level", items, this.agent.reasoning) };
  }
}
