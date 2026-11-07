import { EXAMPLE_CONFIG } from "../core/config.js";
import { REASONING_HINTS, REASONING_LEVELS, isReasoningLevel, type ReasoningLevel } from "../core/reasoning.js";
import { Server } from "../core/server.js";
import { Picker } from "../tui/picker.js";
import type { UiContext } from "./types.js";

/** /endpoint, /model and /reasoning: what the agent talks to, and how. */
export class ConnectionCommands {
  constructor(private readonly app: UiContext) {}

  switchModel(id: string): Promise<void> {
    const { app } = this;
    return app.withActivity(`Checking ${id}…`, async () => {
      const contextSize = await app.server.contextSize(id);
      app.agent.setModel(id, contextSize);
      app.opts.savePreferences({ server: app.server, model: id });
      const window = contextSize ? `${contextSize.toLocaleString()}-token context` : "context size unknown";
      app.print({ kind: "notice", level: "info", text: `Switched to ${id} (${window}).` });
    });
  }

  switchReasoning(level: ReasoningLevel): void {
    const { app } = this;
    app.agent.setReasoning(level);
    app.opts.savePreferences({ server: app.server, reasoning: level });
    app.print({ kind: "notice", level: "info", text: `Reasoning: ${level} (${REASONING_HINTS[level]}).` });
  }

  /** /reasoning <level>, with an error for a level that doesn't exist. */
  setReasoning(arg: string): void {
    if (isReasoningLevel(arg)) return this.switchReasoning(arg);
    this.app.print({ kind: "notice", level: "error", text: `Unknown reasoning level "${arg}". Use one of: ${REASONING_LEVELS.join(", ")}.` });
  }

  /** Connects to a configured endpoint, on `preferredModel` if it serves it, else the model used there last. */
  switchEndpoint(name: string, preferredModel?: string): Promise<void> {
    const { app } = this;
    const endpoint = app.opts.endpoints.find((e) => e.name === name);
    if (!endpoint) {
      const known = app.opts.endpoints.map((e) => e.name).join(", ") || "none";
      app.print({ kind: "notice", level: "error", text: `Unknown endpoint "${name}". Configured: ${known}.` });
      return Promise.resolve();
    }
    return app.withActivity(`Connecting to ${name}…`, async () => {
      const next = Server.fromEndpoint(endpoint);
      const model = await next.chooseModel([preferredModel, app.opts.rememberedModel(next.baseURL)]);
      const contextSize = await next.contextSize(model);
      app.agent.setModel(model, contextSize, next.client);
      app.server = next;
      app.refreshModels();
      app.opts.savePreferences({ server: next, model });
      const window = contextSize ? `${contextSize.toLocaleString()}-token context` : "context size unknown";
      app.print({ kind: "notice", level: "info", text: `Connected to ${next.label}, using ${model} (${window}).` });
    });
  }

  openEndpointPicker(): void {
    const { app } = this;
    const { endpoints, configFile } = app.opts;
    if (endpoints.length === 0) {
      return app.print({ kind: "notice", level: "info", text: `No endpoints are configured. Add them to ${configFile}, for example:\n${EXAMPLE_CONFIG}` });
    }
    const items = endpoints.map((e) => ({ value: e.name, label: e.name, hint: e.model ? `${e.baseURL} · ${e.model}` : e.baseURL }));
    app.openPicker(new Picker("Select an endpoint", items, app.server.name), (name) => {
      if (name !== app.server.name) void this.switchEndpoint(name);
    });
  }

  openModelPicker(): Promise<void> {
    const { app } = this;
    return app.withActivity("Loading models…", async () => {
      const models = await app.server.listModels(true);
      if (models.length === 0) {
        return app.print({ kind: "notice", level: "warn", text: "The server lists no models. Use /model <name> to set one directly." });
      }
      const items = models.map((m) => ({ value: m.id, label: m.id, hint: m.contextSize ? `${m.contextSize.toLocaleString()} ctx` : undefined }));
      app.openPicker(new Picker("Select a model", items, app.agent.model), (id) => {
        if (id !== app.agent.model) void this.switchModel(id);
      });
    });
  }

  openReasoningPicker(): void {
    const { app } = this;
    const items = REASONING_LEVELS.map((l) => ({ value: l, label: l, hint: REASONING_HINTS[l] }));
    app.openPicker(new Picker("Select reasoning level", items, app.agent.reasoning), (level) => {
      if (isReasoningLevel(level) && level !== app.agent.reasoning) this.switchReasoning(level);
    });
  }
}
