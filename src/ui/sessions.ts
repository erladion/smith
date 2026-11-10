import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Picker } from "../tui/picker.js";
import type { ConnectionCommands } from "./connection.js";
import type { Entry } from "./entries.js";
import { isGitRepo, listFolders, shortPath, tildify } from "./folders.js";
import { historyToEntries } from "./replay.js";
import type { ProjectView, SessionControl, UiContext } from "./types.js";

/** /new, /sessions, /name and /open: which conversation, in which folder. */
export class SessionCommands {
  constructor(
    private readonly app: UiContext,
    private readonly connection: ConnectionCommands,
  ) {}

  private get sessions(): SessionControl {
    return this.app.opts.sessions;
  }

  /** Starts a new session, in another folder if one is given. */
  newSession(folder?: string): void {
    const { app } = this;
    const previous = this.sessions.currentId();
    const notes: Entry[] = [];
    if (folder) {
      const entered = this.enterProject(folder);
      if (!entered) return;
      notes.push(...entered);
    } else {
      app.agent.loadConversation([]);
    }
    this.sessions.startNew(app.agent.model, app.server.name);
    const where = folder ? ` in ${tildify(app.project.cwd)}` : "";
    notes.unshift({ kind: "notice", level: "info", text: `Started a new session${where}. The previous one is ${previous}; /sessions lists this folder's sessions.` });
    app.startOver({ resumed: false }, notes);
  }

  /**
   * Makes `folder` the project: a fresh agent for it (its prompt, instructions,
   * skills and permissions), keeping the server, model and reasoning level.
   * Returns notes to show, or null (after printing why) if it isn't a folder.
   */
  private enterProject(folder: string): Entry[] | null {
    const { app } = this;
    let next: ProjectView;
    try {
      next = app.opts.switchProject(folder);
    } catch (err) {
      app.print({ kind: "notice", level: "error", text: (err as Error).message });
      return null;
    }
    const current = { client: app.server.client, model: app.agent.model, reasoning: app.agent.reasoning, contextSize: app.agent.contextLimit };
    app.project = next;
    app.agent = app.opts.createAgent(app.hooks, current);
    const notes = next.warnings.map((text): Entry => ({ kind: "notice", level: "warn", text }));
    if (next.cwd === os.homedir() || next.cwd === "/") {
      notes.push({ kind: "notice", level: "warn", text: `The project is now ${next.cwd}: the agent can change anything under it.` });
    }
    return notes;
  }

  nameSession(name: string): void {
    const { app } = this;
    if (!name) {
      const current = this.sessions.currentName();
      return app.print({
        kind: "notice",
        level: "info",
        text: current ? `This session is named "${current}". /name <new name> renames it.` : "This session has no name yet. /name <name> gives it one; until then, listings use its first message.",
      });
    }
    this.sessions.rename(name);
    const resume = /\s/.test(name) ? `smith --resume "${name}"` : `smith --resume ${name}`;
    app.print({ kind: "notice", level: "info", text: `Named this session "${name}". Resume it from anywhere with: ${resume}` });
  }

  /** /open: recent project folders, and a way into the folder browser. */
  openProjectPicker(): void {
    const { app } = this;
    const recent = this.sessions.recentProjects().filter((p) => p.cwd !== app.project.cwd && fs.existsSync(p.cwd));
    const items = [
      { value: `browse:${app.project.cwd}`, label: "Browse folders…", hint: "starting from the current project" },
      ...recent.map((p) => ({
        value: `use:${p.cwd}`,
        // The folder's name stays readable even when its full path is long.
        label: path.basename(p.cwd) || p.cwd,
        hint: `${p.sessions} session${p.sessions === 1 ? "" : "s"} · ${ago(p.updated)} · ${tildify(path.dirname(p.cwd))}`,
      })),
    ];
    app.openPicker(new Picker("Open a project", items), (value) => this.pickFolder(value));
  }

  /** The folder browser: enter goes into a folder, backspace or .. goes up, "Use this folder" switches. */
  private browseFolder(dir: string): void {
    const { app } = this;
    const sessionCounts = new Map(this.sessions.recentProjects().map((p) => [p.cwd, p.sessions]));
    const describe = (folder: string) => {
      const count = sessionCounts.get(folder);
      return [isGitRepo(folder) && "git", count && `${count} session${count === 1 ? "" : "s"}`].filter(Boolean).join(" · ") || undefined;
    };
    const parent = path.dirname(dir);
    const { names, error } = listFolders(dir);
    const items = [
      { value: `use:${dir}`, label: "✓ Use this folder", hint: describe(dir) ?? (dir === app.project.cwd ? "the current project" : undefined) },
      ...(parent !== dir ? [{ value: `browse:${parent}`, label: "..", hint: "up one level" }] : []),
      ...names.map((name) => ({ value: `browse:${path.join(dir, name)}`, label: `${name}/`, hint: describe(path.join(dir, name)) })),
    ];
    if (error) items.push({ value: `browse:${dir}`, label: `(${error})`, hint: undefined });
    const picker = new Picker(tildify(dir), items, undefined, {
      back: parent !== dir ? `browse:${parent}` : undefined,
      help: "type to filter · enter opens · backspace goes up · esc cancels",
    });
    app.openPicker(picker, (value) => this.pickFolder(value));
  }

  private pickFolder(value: string): void {
    if (value.startsWith("browse:")) this.browseFolder(value.slice("browse:".length));
    else if (value.startsWith("use:")) this.newSession(value.slice("use:".length));
  }

  openSessionPicker(everywhere: boolean): void {
    const { app } = this;
    const current = this.sessions.currentId();
    const sessions = this.sessions.list(everywhere);
    if (sessions.length === 0 || (sessions.length === 1 && sessions[0]!.id === current)) {
      const where = everywhere ? "" : " for this folder; /sessions all shows every folder's";
      return app.print({ kind: "notice", level: "info", text: `There are no other saved sessions${where}.` });
    }
    const folders = new Map(sessions.map((s) => [s.id, s.cwd]));
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const items = sessions.map((s) => ({
      value: s.id,
      label: s.name,
      hint: [
        everywhere && shortPath(s.cwd, 32),
        ago(s.updated),
        `${s.turns} message${s.turns === 1 ? "" : "s"}`,
        `${s.endpoint ? `${s.endpoint}/` : ""}${s.model}`,
      ]
        .filter(Boolean)
        .join(" · "),
    }));
    const title = everywhere ? "Switch session (all folders)" : "Switch session (this folder; /sessions all for every folder)";
    const action = {
      key: "d",
      hint: "delete",
      check: (item: { value: string; label: string }) => {
        if (item.value === this.sessions.currentId()) return { refuse: "That's the session you're in; switch to another one first." };
        const turns = byId.get(item.value)?.turns ?? 0;
        return { ask: `Delete "${item.label}" (${turns} message${turns === 1 ? "" : "s"}) and its tool log?` };
      },
    };
    app.openPicker(
      new Picker(title, items, current, { action }),
      (id) => {
        if (id !== this.sessions.currentId()) void this.switchSession(id, folders.get(id));
      },
      (id) => this.deleteSession(id, everywhere, byId.get(id)?.name ?? id),
    );
  }

  /** Deletes a session from the picker, then shows the picker again. */
  private deleteSession(id: string, everywhere: boolean, name: string): void {
    try {
      this.sessions.remove(id);
    } catch (err) {
      return this.app.print({ kind: "notice", level: "error", text: `Could not delete the session: ${(err as Error).message}` });
    }
    this.app.print({ kind: "notice", level: "info", text: `Deleted the session "${name}" (${id}) and its tool log.` });
    this.openSessionPicker(everywhere);
  }

  /** Opens a session; one from another folder moves there, to work where it was recorded. */
  private async switchSession(id: string, folder: string | undefined): Promise<void> {
    const { app } = this;
    let notes: Entry[] = [];
    if (folder && folder !== app.project.cwd) {
      if (!fs.existsSync(folder)) {
        return app.print({ kind: "notice", level: "error", text: `That session's folder, ${folder}, doesn't exist anymore.` });
      }
      const entered = this.enterProject(folder);
      if (!entered) return;
      notes = [{ kind: "notice", level: "info", text: `Now working in ${tildify(folder)}.` }, ...entered];
    }
    let opened: ReturnType<SessionControl["open"]>;
    try {
      opened = this.sessions.open(id);
    } catch (err) {
      return app.print({ kind: "notice", level: "error", text: `Could not open session ${id}: ${(err as Error).message}` });
    }
    app.agent.loadConversation(opened.messages);
    app.startOver({ resumed: true, lastUsed: opened.lastUsed }, [...notes, ...historyToEntries(opened.messages, app.project.tools)]);

    // Continue on the endpoint and model the session last used, when they're available.
    const { endpoint, model } = opened;
    if (endpoint && endpoint !== app.server.name && app.opts.endpoints.some((e) => e.name === endpoint)) {
      await this.connection.switchEndpoint(endpoint, model);
    } else if (model !== app.agent.model) {
      const served = await app.server.listModels().catch(() => []);
      if (served.some((m) => m.id === model)) await this.connection.switchModel(model);
      else app.print({ kind: "notice", level: "warn", text: `This session used ${model}, which ${app.server.label} doesn't serve; continuing with ${app.agent.model}.` });
    }
  }
}

/** "just now", "5 min ago", "3 h ago", "yesterday", or a date. */
function ago(date: Date): string {
  const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  if (hours < 48) return "yesterday";
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
