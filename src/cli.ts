#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Agent } from "./core/agent.js";
import { type Config, EXAMPLE_CONFIG, loadConfig } from "./core/config.js";
import type { AgentEvent } from "./core/events.js";
import type { Message } from "./core/history.js";
import { loadPreferences, type Preferences, savePreferences } from "./core/preferences.js";
import { findRepoRoot, loadInstructions } from "./core/instructions.js";
import { buildSystemPrompt } from "./core/prompt.js";
import { isReasoningLevel, REASONING_LEVELS, type ReasoningLevel } from "./core/reasoning.js";
import { Sandbox, type SandboxMode } from "./core/sandbox.js";
import { Server } from "./core/server.js";
import { listSessions, Session } from "./core/session.js";
import { loadSkills, skillRoots } from "./core/skills.js";
import { defaultTools } from "./core/tools/index.js";
import { createSkillTool } from "./core/tools/skill.js";
import { type AgentHooks, TuiApp } from "./ui/app.js";
import { describeError } from "./core/errors.js";

const HELP = `Usage: agent [options]

Server:
  -e, --endpoint <name>  Use an endpoint from the config file (default: last used, else the config's default)
  --endpoints            List configured endpoints
  --base-url <url>       Use this OpenAI-compatible URL instead of a configured endpoint (env AGENT_BASE_URL)
  --api-key <key>        API key (for --base-url also env AGENT_API_KEY or OPENAI_API_KEY)
  --model <name>         Model (env AGENT_MODEL; default: last used on this server, else the
                         endpoint's configured model, else the first listed)
  --reasoning <level>    ${REASONING_LEVELS.join(" | ")} (default: last used, else "default")
  --context-size <n>     Context window in tokens, if the server doesn't report it
  --temperature <n>      Sampling temperature (default: the server's)

Sandbox (shell commands run in bubblewrap):
  --sandbox <mode>       auto | on | off (default auto: use bwrap if it works, else warn)
  --network              Allow sandboxed commands to use the network (default: blocked)

Sessions:
  -c, --continue         Resume the most recent session in this directory
  -r, --resume <id>      Resume a session by id
  --sessions             List saved sessions for this directory

One-shot:
  -p, --print <prompt>   Run one prompt without the TUI and print the answer
  -y, --yes              With --print, allow every tool call without asking

  -h, --help             Show this help

Endpoints are configured in ~/.config/agent/config.json; run --endpoints for an example.`;

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      endpoint: { type: "string", short: "e" },
      endpoints: { type: "boolean" },
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      model: { type: "string" },
      reasoning: { type: "string" },
      "context-size": { type: "string" },
      temperature: { type: "string" },
      sandbox: { type: "string" },
      network: { type: "boolean" },
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
  const config = loadConfig();
  if (values.endpoints) {
    printEndpoints(config);
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

  const prefs = loadPreferences();
  const server = chooseServer(values, config, prefs, resumed?.session.endpoint);

  const temperature = parseNumber(values.temperature, "--temperature");
  const reasoning = resolveReasoning(values.reasoning, prefs.reasoning);
  const model =
    values.model ??
    process.env.AGENT_MODEL ??
    (await server.chooseModel([resumed?.session.model, prefs.models?.[server.baseURL]]));
  const contextSize = parseNumber(values["context-size"], "--context-size") ?? (await server.contextSize(model));

  const sandboxMode = values.sandbox ?? "auto";
  if (!["auto", "on", "off"].includes(sandboxMode)) throw new Error("--sandbox must be auto, on or off");
  const sandbox = Sandbox.create(sandboxMode as SandboxMode, values.network ?? false);

  const instructions = loadInstructions(cwd);
  const { skills, warnings: skillWarnings } = loadSkills(skillRoots(findRepoRoot(cwd) ?? cwd));
  const tools = skills.length ? [...defaultTools, createSkillTool(skills)] : defaultTools;
  sandbox.readOnlyPaths = skills.map((s) => s.dir);
  const warnings = [...config.warnings, ...skillWarnings];

  const session = resumed?.session ?? Session.create(cwd, model, server.name);
  session.recordModel(model, server.name);
  const history = resumed?.messages ?? [];
  const createAgent = (hooks: AgentHooks) =>
    new Agent({
      client: server.client,
      model,
      reasoning,
      cwd,
      temperature,
      contextSize,
      sandbox,
      history,
      tools,
      systemPrompt: buildSystemPrompt(cwd, { instructions, skills }),
      onHistory: (change) => session.record(change),
      ...hooks,
    });

  if (values.print !== undefined) {
    for (const warning of warnings) process.stderr.write(`[warn] ${warning}\n`);
    process.stderr.write(`[${server.label} · ${model} · ${sandbox.describe()}]\n`);
    await runHeadless(createAgent, values.print, values.yes ?? false, server.baseURL);
    process.stderr.write(`[session ${session.id}]\n`);
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("The interactive UI needs a terminal. Use -p <prompt> for non-interactive runs.");
  }
  await new TuiApp({
    createAgent,
    server,
    endpoints: config.endpoints,
    configFile: config.file,
    warnings,
    rememberedModel: (baseURL) => loadPreferences().models?.[baseURL],
    sandbox,
    cwd,
    sessionId: session.id,
    resumed: history,
    tools,
    instructions: instructions.map((f) => displayPath(f.path, cwd)),
    skills,
    savePreferences: ({ server, model, reasoning }) => {
      if (model) session.recordModel(model, server.name);
      savePreferences({
        reasoning,
        endpoint: model ? server.name : undefined,
        model: model ? { baseURL: server.baseURL, id: model } : undefined,
      });
    },
  }).run();
  console.log(`Session ${session.id}. Resume with: agent --resume ${session.id}`);
}

/** A short path for display: relative to the project when nearby, else with ~ for the home folder. */
function displayPath(file: string, cwd: string): string {
  const rel = path.relative(cwd, file);
  if (!rel.startsWith(`..${path.sep}..`)) return rel;
  const home = os.homedir();
  return file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file;
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

const DEFAULT_BASE_URL = "http://localhost:8080/v1";

/**
 * Which server to start on: --endpoint, then an explicit URL (--base-url or
 * AGENT_BASE_URL), then the resumed session's endpoint, the last one used,
 * the config's default, the first configured, and finally localhost:8080.
 */
function chooseServer(
  flags: { endpoint?: string; "base-url"?: string; "api-key"?: string },
  config: Config,
  prefs: Preferences,
  sessionEndpoint: string | undefined,
): Server {
  const keyFlag = flags["api-key"];
  const find = (name: string | undefined) => (name ? config.endpoints.find((e) => e.name === name) : undefined);

  if (flags.endpoint) {
    const endpoint = find(flags.endpoint);
    if (!endpoint) {
      const known = config.endpoints.map((e) => e.name).join(", ") || "none";
      throw new Error(`Unknown endpoint "${flags.endpoint}". Configured in ${config.file}: ${known}.`);
    }
    return Server.fromEndpoint(endpoint, keyFlag);
  }

  const url = flags["base-url"] ?? process.env.AGENT_BASE_URL;
  const envKey = keyFlag ?? process.env.AGENT_API_KEY ?? process.env.OPENAI_API_KEY ?? "no-key";
  if (url) return new Server(url, envKey);

  const endpoint =
    find(sessionEndpoint) ?? find(prefs.endpoint) ?? find(config.defaultEndpoint) ?? config.endpoints[0];
  return endpoint ? Server.fromEndpoint(endpoint, keyFlag) : new Server(DEFAULT_BASE_URL, envKey);
}

function printEndpoints(config: Config): void {
  if (config.endpoints.length === 0) {
    console.log(`No endpoints configured. Create ${config.file}, for example:\n\n${EXAMPLE_CONFIG}`);
    console.log(`\nUse "apiKeyEnv" to read a key from an environment variable instead of storing it in the file.`);
    return;
  }
  console.log(`From ${config.file}:\n`);
  for (const e of config.endpoints) {
    const marks = [e.name === config.defaultEndpoint && "default", e.apiKey && "key"].filter(Boolean).join(", ");
    console.log(`${e.name.padEnd(16)} ${e.baseURL.padEnd(36)} ${(e.model ?? "").padEnd(24)} ${marks}`);
  }
  for (const warning of config.warnings) console.log(`\nwarning: ${warning}`);
}

function printSessions(cwd: string): void {
  const sessions = listSessions(cwd);
  if (sessions.length === 0) {
    console.log("No saved sessions for this directory.");
    return;
  }
  for (const s of sessions) {
    const when = s.updated.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
    const where = s.endpoint ? `${s.endpoint}/${s.model}` : s.model;
    console.log(`${s.id}  ${when.padEnd(17)}  ${where.padEnd(32).slice(0, 32)}  ${s.preview}`);
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
