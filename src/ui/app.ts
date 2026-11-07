import type { Agent, ApprovalDecision, ApprovalRequest } from "../core/agent.js";
import { describeError } from "../core/errors.js";
import type { AgentEvent, BlockKind } from "../core/events.js";
import type { Server } from "../core/server.js";
import { LineEditor } from "../tui/editor.js";
import { type Key, KeyReader } from "../tui/keys.js";
import { markdownLines, safeSplit } from "../tui/markdown.js";
import type { Picker } from "../tui/picker.js";
import { InlineRenderer } from "../tui/renderer.js";
import type { Line } from "../tui/style.js";
import { prefixed, truncate, wrap } from "../tui/text.js";
import { helpText } from "./commands.js";
import { ConnectionCommands } from "./connection.js";
import { formatDuration, turnSummary } from "./duration.js";
import { box, DIM, type Entry, entryLines, REASONING } from "./entries.js";
import { greeting } from "./greetings.js";
import { historyToEntries } from "./replay.js";
import { SessionCommands } from "./sessions.js";
import { SuggestionList } from "./suggestions.js";
import type { AgentHooks, ProjectView, TuiOptions, UiContext } from "./types.js";
import { approvalBox, runningLabel, SPINNER, statusLine } from "./view.js";

interface Terminal {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
}

const HELP = helpText();

/**
 * The interactive terminal UI: a transcript above, a live region below.
 * This class runs the screen, the keys and agent turns; the commands that
 * switch session, project, endpoint or model are in sessions.ts and
 * connection.ts, and work through the UiContext it implements.
 */
export class TuiApp implements UiContext {
  private readonly renderer: InlineRenderer;
  private readonly keys = new KeyReader();
  private readonly editor = new LineEditor();
  private readonly suggestions = new SuggestionList();
  private readonly connection: ConnectionCommands;
  private readonly sessions: SessionCommands;
  readonly hooks: AgentHooks;
  agent: Agent;
  project: ProjectView;
  server: Server;

  private live: { kind: BlockKind; text: string } | null = null;
  private activity: string | null = null;
  private approval: (ApprovalRequest & { resolve: (d: ApprovalDecision) => void }) | null = null;
  private picker: { picker: Picker; onPick: (value: string) => void } | null = null;
  private busy = false;
  private abort: AbortController | null = null;
  private context: { tokens: number; limit?: number } | null = null;
  /** The running turn: when it started, how many tools it ran, how it ended. */
  private turn: { started: number; toolCalls: number; reason?: string } | null = null;
  /** Tools running right now (several when read-only tools run in parallel), by call id. */
  private readonly running = new Map<string, string>();

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
    readonly opts: TuiOptions,
    private readonly term: Terminal = { input: process.stdin, output: process.stdout },
  ) {
    this.server = opts.server;
    this.renderer = new InlineRenderer(term.output);
    this.project = opts.project;
    this.hooks = { onEvent: (e) => this.onEvent(e), approve: (r) => this.approve(r) };
    this.agent = opts.createAgent(this.hooks);
    this.connection = new ConnectionCommands(this);
    this.sessions = new SessionCommands(this, this.connection);
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

    this.printBanner(this.opts.resumed.length > 0);
    for (const text of this.opts.warnings) this.print({ kind: "notice", level: "warn", text });
    for (const entry of historyToEntries(this.opts.resumed, this.project.tools)) this.print(entry);
    this.refreshModels();
    this.render();

    return new Promise((resolve) => (this.finished = resolve));
  }

  // ---- UiContext ----

  refreshModels(): void {
    this.server
      .listModels()
      .then((models) => {
        this.suggestions.models = models.map((m) => m.id);
      })
      .catch(() => {});
  }

  print(entry: Entry): void {
    this.transcript.push(entry);
    this.printedWidth = this.width;
    this.renderer.print(entryLines(entry, this.width));
    this.requestRender();
  }

  startOver(resumed: boolean, entries: Entry[]): void {
    this.renderer.reset();
    this.transcript.length = 0;
    this.live = null;
    this.context = null;
    this.printBanner(resumed);
    for (const entry of entries) this.print(entry);
  }

  openPicker(picker: Picker, onPick: (value: string) => void): void {
    this.picker = { picker, onPick };
    this.requestRender();
  }

  async withActivity(activity: string, work: () => Promise<void>): Promise<void> {
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

  private printBanner(resumed: boolean): void {
    const { sandbox, sessions } = this.opts;
    this.print({
      kind: "banner",
      model: this.agent.model,
      server: this.server.label,
      cwd: this.project.cwd,
      session: sessions.currentName() ? `${sessions.currentName()} · ${sessions.currentId()}` : sessions.currentId(),
      resumed,
      sandbox: { active: sandbox.active, description: sandbox.describe() },
      instructions: this.project.instructions,
      skills: this.project.skills.map((s) => s.name),
      greeting: greeting(resumed),
    });
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
      const elapsed = this.turn ? ` · ${formatDuration(Date.now() - this.turn.started)}` : "";
      lines.push([], truncate([{ text: SPINNER[this.frame]!, style: { color: "yellow" } }, { text: ` ${this.activity}${elapsed}`, style: DIM }], width));
    }
    if (this.approval) {
      lines.push([], ...approvalBox(this.approval, width, this.term.output.rows || 24));
    } else if (this.picker) {
      lines.push([], ...box(this.picker.picker.lines(), "cyan", width));
    } else if (!this.busy || this.agentRunning) {
      const queued = this.agent.queuedMessages;
      if (queued.length > 0) {
        lines.push([]);
        for (const text of queued) lines.push(...prefixed([{ text: "› ", style: DIM }], [{ text: "  " }], [{ text, style: DIM }], width));
        lines.push([{ text: "  queued: the agent gets this at its next step", style: { ...DIM, italic: true } }]);
      }
      const placeholder = this.busy ? "Type to add to what the agent is doing (enter queues it)" : "Ask for something, or /help";
      const prompt = prefixed([{ text: "› ", style: { color: "cyan" } }], [{ text: "  " }], this.editor.render(placeholder), width - 4);
      lines.push([], ...box(prompt, "gray", width, true));
      lines.push(...this.suggestions.lines(this.currentSuggestions(), width));
    }
    lines.push(
      statusLine(
        {
          endpoint: this.server.name,
          model: this.agent.model,
          reasoning: this.agent.reasoning,
          context: this.context,
          sandbox: this.opts.sandbox,
          busy: this.busy,
          queueing: this.agentRunning,
        },
        width,
      ),
    );
    return lines;
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
      case "user_message":
        this.flushLive();
        this.print({ kind: "user", text: event.text });
        break;
      case "tool_start":
        this.running.set(event.id, `${event.name} ${event.summary}`);
        this.activity = runningLabel([...this.running.values()]);
        break;
      case "tool_end":
        if (this.turn) this.turn.toolCalls++;
        this.running.delete(event.id);
        this.activity = runningLabel([...this.running.values()]);
        this.print({ kind: "tool", name: event.name, summary: event.summary, output: event.output, isError: event.isError, diff: event.diff });
        break;
      case "context":
        this.context = { tokens: event.tokens, limit: event.limit };
        break;
      case "activity":
        // Progress from inside a tool (a sub-agent); say so when several run at once.
        this.activity = this.running.size > 1 ? `${this.running.size} in parallel · ${event.text}` : event.text;
        break;
      case "notice":
        this.flushLive();
        this.print({ kind: "notice", level: event.level, text: event.text });
        break;
      case "done":
        if (this.turn) this.turn.reason = event.reason;
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

  /** Command suggestions for the input, unless something else has the keys. */
  private currentSuggestions() {
    if (this.busy || this.approval || this.picker) return [];
    return this.suggestions.items(this.editor.value, { cwd: this.project.cwd, endpoints: this.opts.endpoints.map((e) => e.name) });
  }

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
      const open = this.picker;
      const result = open.picker.handle(key);
      if (result === "cancel") this.picker = null;
      else if (result) {
        // Cleared first: choosing can open the next picker (the folder browser).
        this.picker = null;
        open.onPick(result.value);
      }
      return;
    }

    if (this.busy) {
      if (key.name === "escape") this.abort?.abort();
      else if (this.agentRunning && this.editor.handle(key) === "submit") this.queueMessage(this.editor.commit());
      return;
    }

    if (key.name === "char" && key.ctrl && key.text === "d" && !this.editor.value) return this.exit();

    // While command suggestions are showing, arrows pick one, tab completes it and enter runs it.
    const handled = this.suggestions.handle(key, this.currentSuggestions(), this.editor.value, (value) => this.editor.setValue(value));
    if (handled === "handled") return;
    if (handled) {
      this.editor.setValue(handled.run);
      return void this.submit(this.editor.commit());
    }

    const before = this.editor.value;
    if (this.editor.handle(key) === "submit") void this.submit(this.editor.commit());
    if (this.editor.value !== before) this.suggestions.reset();
  }

  // ---- turns and commands ----

  /** Whether an agent turn is running (as opposed to e.g. switching model), so typing can be queued. */
  private get agentRunning(): boolean {
    return this.busy && this.abort !== null;
  }

  /** A message typed while the agent works: queued for its next step. */
  private queueMessage(value: string): void {
    const text = value.trim();
    if (!text) return;
    if (text.startsWith("/")) {
      this.editor.setValue(value);
      this.print({ kind: "notice", level: "warn", text: "Commands work once the agent is done. Your command is still in the input box." });
      return;
    }
    this.agent.queue(text);
  }

  private async submit(value: string): Promise<void> {
    const text = value.trim();
    if (!text) return;
    if (text.startsWith("/")) return this.runCommand(text);

    this.print({ kind: "user", text });
    this.turn = { started: Date.now(), toolCalls: 0 };
    await this.runBusy("Thinking…", (signal) => this.agent.send(text, signal));
    const turn = this.turn;
    this.turn = null;
    if (turn && !this.closed) this.print({ kind: "meta", text: turnSummary(turn.reason, Date.now() - turn.started, turn.toolCalls) });
  }

  /** Runs a slash command; commands.ts lists them for /help and the suggestions. */
  private runCommand(text: string): void | Promise<void> {
    const [command, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ");
    const { sessions, connection } = this;
    switch (command) {
      case "/exit":
      case "/quit":
        return this.exit();
      case "/help":
        return this.print({ kind: "notice", level: "info", text: HELP });
      case "/new":
      case "/clear":
        return sessions.newSession(arg);
      case "/sessions":
      case "/resume":
        return sessions.openSessionPicker(arg === "all");
      case "/name":
        return sessions.nameSession(arg);
      case "/open":
        return sessions.openProjectPicker();
      case "/endpoint":
        return arg ? connection.switchEndpoint(arg) : connection.openEndpointPicker();
      case "/model":
        return arg ? connection.switchModel(arg) : connection.openModelPicker();
      case "/reasoning":
        return arg ? connection.setReasoning(arg) : connection.openReasoningPicker();
      case "/network":
        return this.setNetwork(arg);
      case "/undo":
        return this.undo();
      case "/skills":
        return this.listSkills();
      case "/compact":
        return this.runBusy("Compacting…", (signal) => this.agent.compactNow(signal));
      default:
        return this.print({ kind: "notice", level: "error", text: `Unknown command ${command}. Type /help for the list.` });
    }
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
      this.running.clear();
      this.busy = false;
      // Messages the agent never got (interrupted, error, step limit) go back into the input.
      const undelivered = this.agent.takeQueued();
      if (undelivered.length > 0) {
        const typing = this.editor.value.trim();
        this.editor.setValue([...undelivered, ...(typing ? [typing] : [])].join("\n\n"));
        this.print({ kind: "notice", level: "warn", text: "Your queued message wasn't delivered, so it's back in the input box." });
      }
      this.requestRender();
    }
  }

  private async undo(): Promise<void> {
    const result = await this.agent.undo();
    if (!result) return this.print({ kind: "notice", level: "info", text: "Nothing to undo." });
    const cwd = this.project.cwd;
    const rel = (f: string) => (f.startsWith(cwd + "/") ? f.slice(cwd.length + 1) : f);
    const lines = ["Undid the last turn and removed it from the conversation."];
    if (result.restored.length) lines.push(`Restored: ${result.restored.map(rel).join(", ")}`);
    if (result.skipped.length) lines.push(`Left alone because they changed afterwards: ${result.skipped.map(rel).join(", ")}`);
    if (result.untracked.length) lines.push(`Not undone: anything changed by ${result.untracked.join(", ")} commands.`);
    this.print({ kind: "notice", level: result.skipped.length || result.untracked.length ? "warn" : "info", text: lines.join("\n") });
    this.editor.setValue(result.prompt);
  }

  private listSkills(): void {
    const { skills } = this.project;
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
}
