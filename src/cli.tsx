#!/usr/bin/env node
import { render } from "ink";
import OpenAI from "openai";
import { parseArgs } from "node:util";
import { Agent } from "./core/agent.js";
import type { AgentEvent } from "./core/events.js";
import type { Message } from "./core/history.js";
import { loadPreferences, savePreferences } from "./core/preferences.js";
import { buildSystemPrompt } from "./core/prompt.js";
import { isReasoningLevel, REASONING_LEVELS, type ReasoningLevel } from "./core/reasoning.js";
import { Server } from "./core/server.js";
import { listSessions, Session } from "./core/session.js";
import { defaultTools } from "./core/tools/index.js";
import { type AgentHooks, App } from "./ui/App.js";
import { describeError } from "./ui/errors.js";

const HELP = `Usage: agent [options]

Server:
  --base-url <url>       OpenAI-compatible endpoint (env AGENT_BASE_URL, default http://localhost:8080/v1)
  --api-key <key>        API key (env AGENT_API_KEY or OPENAI_API_KEY; llama-server needs none by default)
  --model <name>         Model (env AGENT_MODEL; default: last used on this server, else the first listed)
  --reasoning <level>    ${REASONING_LEVELS.join(" | ")} (default: last used, else "default")
  --context-size <n>     Context window in tokens, if the server doesn't report it
  --temperature <n>      Sampling temperature (default: the server's)

Sessions:
  -c, --continue         Resume the most recent session in this directory
  -r, --resume <id>      Resume a session by id
  --sessions             List saved sessions for this directory

One-shot:
  -p, --print <prompt>   Run one prompt without the TUI and print the answer
  -y, --yes              With --print, allow every tool call without asking

  -h, --help             Show this help`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      model: { type: "string" },
      reasoning: { type: "string" },
      "context-size": { type: "string" },
      temperature: { type: "string" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      sessions: { type: "boolean" },
      print: { type: "string", short: "p" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }

  const cwd = process.cwd();
  if (values.sessions) {
    printSessions(cwd);
    return;
  }

  // Resume first: a resumed session suggests which model to use.
  let resumed: { session: Session; messages: Message[] } | null = null;
  if (values.resume) {
    resumed = Session.open(values.resume);
  } else if (values.continue) {
    const latest = listSessions(cwd)[0];
    if (!latest) throw new Error("No saved session for this directory.");
    resumed = Session.open(latest.id);
  }

  const baseURL = values["base-url"] ?? process.env.AGENT_BASE_URL ?? "http://localhost:8080/v1";
  const apiKey = values["api-key"] ?? process.env.AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "no-key";
  const client = new OpenAI({ baseURL, apiKey, maxRetries: 1 });
  const server = new Server(client, baseURL, apiKey);
  const prefs = loadPreferences();

  const temperature = parseNumber(values.temperature, "--temperature");
  const reasoning = resolveReasoning(values.reasoning, prefs.reasoning);
  const model =
    values.model ??
    process.env.AGENT_MODEL ??
    (await pickModel(server, [resumed?.session.model, prefs.models?.[baseURL]]));
  const contextSize = parseNumber(values["context-size"], "--context-size") ?? (await server.contextSize(model));

  const session = resumed?.session ?? Session.create(cwd, model);
  const history = resumed?.messages ?? [];
  const createAgent = (hooks: AgentHooks) =>
    new Agent({
      client,
      model,
      reasoning,
      cwd,
      temperature,
      contextSize,
      history,
      tools: defaultTools,
      systemPrompt: buildSystemPrompt(cwd),
      onHistory: (change) => session.record(change),
      ...hooks,
    });

  if (values.print !== undefined) {
    await runHeadless(createAgent, values.print, values.yes ?? false, baseURL);
    process.stderr.write(`[session ${session.id}]\n`);
    return;
  }

  const app = render(
    <App
      createAgent={createAgent}
      server={server}
      cwd={cwd}
      sessionId={session.id}
      resumed={history}
      tools={defaultTools}
      savePreferences={(update) => {
        if (update.model) session.recordModel(update.model);
        savePreferences({
          reasoning: update.reasoning,
          model: update.model ? { baseURL, id: update.model } : undefined,
        });
      }}
    />,
  );
  await app.waitUntilExit();
  console.log(`Session ${session.id}. Resume with: agent --resume ${session.id}`);
}

function parseNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`${flag} must be a number`);
  return n;
}

function resolveReasoning(flag: string | undefined, saved: ReasoningLevel | undefined): ReasoningLevel {
  if (flag === undefined) return saved ?? "default";
  if (!isReasoningLevel(flag)) throw new Error(`--reasoning must be one of: ${REASONING_LEVELS.join(", ")}`);
  return flag;
}

/** The first preferred model the server still serves, else the first it lists. */
async function pickModel(server: Server, preferred: (string | undefined)[]): Promise<string> {
  let models;
  try {
    models = await server.listModels();
  } catch (err) {
    throw new Error(`Could not list models at ${server.baseURL}: ${describeError(err, server.baseURL)}\nStart the server or pass --model.`);
  }
  const ids = new Set(models.map((m) => m.id));
  const match = preferred.find((id): id is string => id !== undefined && ids.has(id));
  const chosen = match ?? models[0]?.id;
  if (!chosen) throw new Error(`${server.baseURL} lists no models. Pass --model.`);
  return chosen;
}

function printSessions(cwd: string): void {
  const sessions = listSessions(cwd);
  if (sessions.length === 0) {
    console.log("No saved sessions for this directory.");
    return;
  }
  for (const s of sessions) {
    const when = s.updated.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    console.log(`${s.id}  ${when.padEnd(17)}  ${s.model.padEnd(24).slice(0, 24)}  ${s.preview}`);
  }
}

async function runHeadless(
  createAgent: (hooks: AgentHooks) => Agent,
  prompt: string,
  allowAll: boolean,
  baseURL: string,
): Promise<void> {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  const onEvent = (event: AgentEvent) => {
    switch (event.type) {
      case "delta":
        if (event.kind === "text") process.stdout.write(event.text);
        break;
      case "response_end":
        process.stdout.write("\n");
        break;
      case "tool_end":
        process.stderr.write(`[${event.isError ? "✗" : "✓"} ${event.name}] ${event.summary}\n`);
        break;
      case "notice":
        process.stderr.write(`[${event.level}] ${event.text}\n`);
        break;
    }
  };

  const agent = createAgent({
    onEvent,
    approve: async ({ tool, summary }) => {
      if (allowAll) return "allow";
      process.stderr.write(`[denied ${tool}] ${summary} (pass --yes to allow tools)\n`);
      return "deny";
    },
  });

  try {
    await agent.send(prompt, controller.signal);
  } catch (err) {
    process.stderr.write(`${describeError(err, baseURL)}\n`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
