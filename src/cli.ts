#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Agent } from "./core/agent.js";
import { type Config, EXAMPLE_CONFIG, loadConfig } from "./core/config.js";
import type { AgentEvent } from "./core/events.js";
import type { Message } from "./core/history.js";
import { loadPreferences, type Preferences, savePreferences } from "./core/preferences.js";
import { findRepoRoot, type InstructionFile, loadInstructions } from "./core/instructions.js";
import { buildSubagentPrompt, buildSystemPrompt } from "./core/prompt.js";
import { isReasoningLevel, REASONING_LEVELS, type ReasoningLevel } from "./core/reasoning.js";
import { Sandbox, type SandboxMode } from "./core/sandbox.js";
import { Server } from "./core/server.js";
import { findSession, listSessions, secureSessions, Session } from "./core/session.js";
import { loadSkills, type Skill, skillRoots } from "./core/skills.js";
import type { ToolDef } from "./core/tool.js";
import { fastTools } from "./core/toolchain.js";
import { defaultTools } from "./core/tools/index.js";
import { createSkillTool } from "./core/tools/skill.js";
import { type AgentHooks, type AgentSettings, type ProjectView, TuiApp } from "./ui/app.js";
import { turnSummary } from "./ui/duration.js";
import { shortPath } from "./ui/folders.js";
import { FAREWELL } from "./ui/greetings.js";
import { describeError } from "./core/errors.js";
import { useSystemNetworkSettings } from "./core/network.js";
import { ToolLog } from "./core/toollog.js";
import { VERSION } from "./version.js";

const HELP = `Usage: agent [options] [folder]

Works in [folder], or the current directory. That folder is the project: the only place the
agent can change files.

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
  --max-steps <n>        Model calls allowed per message (default: maxSteps in the config file, else 50)

Sandbox (shell commands run in bubblewrap):
  --sandbox <mode>       on | off (default on: the agent won't start if bubblewrap can't run;
                         off runs commands unsandboxed and must be asked for explicitly)
  --network              Allow sandboxed commands to use the network (default: blocked)

Sessions:
  -c, --continue         Resume the most recent session in this directory
  -r, --resume <id|name> Resume a session by id or name (in the folder it was in)
  --sessions             List saved sessions from every folder (agent <folder> --sessions: only that one)

One-shot:
  -p, --print <prompt>   Run one prompt without the TUI and print the answer
  -y, --yes              With --print, allow every tool call without asking

  -v, --version          Show the version
  -h, --help             Show this help

Endpoints are configured in ~/.config/agent/config.json; run --endpoints for an example.`;

async function main(): Promise<void> {
  useSystemNetworkSettings();
  secureSessions();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      endpoint: { type: "string", short: "e" },
      endpoints: { type: "boolean" },
      "base-url": { type: "string" },
      "api-key": { type: "string" },
      model: { type: "string" },
      reasoning: { type: "string" },
      "context-size": { type: "string" },
      temperature: { type: "string" },
      "max-steps": { type: "string" },
      sandbox: { type: "string" },
      network: { type: "boolean" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      sessions: { type: "boolean" },
      print: { type: "string", short: "p" },
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (values.version) {
    console.log(`agent ${VERSION}`);
    return;
  }

  if (positionals.length > 1) throw new Error("Give at most one folder to work in.");
  if (positionals[0]) process.chdir(resolveFolder(positionals[0], process.cwd()));
  if (values.sessions) {
    printSessions(positionals[0] ? process.cwd() : undefined);
    return;
  }
  // Resume first: a resumed session suggests which model to use, and where to work.
  let resumed: { session: Session; messages: Message[] } | null = null;
  if (values.resume) {
    resumed = Session.open(findSession(values.resume));
    // Work where the session happened, unless a folder was given.
    if (!positionals[0] && fs.existsSync(resumed.session.cwd)) process.chdir(resumed.session.cwd);
  } else if (values.continue) {
    const latest = listSessions(process.cwd())[0];
    if (!latest) throw new Error("No saved session for this directory.");
    resumed = Session.open(latest.id);
  }

  const cwd = process.cwd();
  const config = loadConfig();
  if (values.endpoints) {
    printEndpoints(config);
    return;
  }

  const prefs = loadPreferences();
  const server = chooseServer(values, config, prefs, resumed?.session.endpoint);

  const temperature = parseNumber(values.temperature, "--temperature");
  const maxSteps = parseNumber(values["max-steps"], "--max-steps") ?? config.maxSteps ?? 50;
  if (!Number.isInteger(maxSteps) || maxSteps < 1) throw new Error("--max-steps must be a whole number of at least 1");
  const reasoning = resolveReasoning(values.reasoning, prefs.reasoning);
  const model =
    values.model ??
    process.env.AGENT_MODEL ??
    (await server.chooseModel([resumed?.session.model, prefs.models?.[server.baseURL]]));
  const contextSize = parseNumber(values["context-size"], "--context-size") ?? (await server.contextSize(model));

  const sandboxMode = values.sandbox ?? "on";
  if (!["on", "off"].includes(sandboxMode)) throw new Error("--sandbox must be on or off");
  const sandbox = Sandbox.create(sandboxMode as SandboxMode, values.network ?? false);

  // The project being worked in; /new <folder> in the TUI switches it.
  let project = loadProject(cwd);
  sandbox.readOnlyPaths = project.skills.map((s) => s.dir);
  const warnings = [...config.warnings, ...project.warnings];

  // The session being recorded; /sessions and /new in the TUI switch it.
  let session = resumed?.session ?? Session.create(cwd, model, server.name);
  session.recordModel(model, server.name);
  const history = resumed?.messages ?? [];
  const toolLog = config.toolLog ? new ToolLog(() => session.id, () => project.cwd) : undefined;
  /**
   * An agent for the current project. The first one continues the resumed
   * conversation with the startup settings; later ones (a new project) start
   * empty with the settings in use at that moment.
   */
  const createAgent = (hooks: AgentHooks, current?: AgentSettings) => {
    const { instructions, skills } = project;
    return new Agent({
      client: current?.client ?? server.client,
      model: current?.model ?? model,
      reasoning: current?.reasoning ?? reasoning,
      contextSize: current ? current.contextSize : contextSize,
      history: current ? [] : history,
      cwd: project.cwd,
      temperature,
      maxSteps,
      sandbox,
      tools: project.tools,
      systemPrompt: buildSystemPrompt(project.cwd, { instructions, skills, fastTools: fastTools() }),
      subagentPrompt: config.subagents ? buildSubagentPrompt(project.cwd, { instructions, skills }) : undefined,
      onHistory: (change) => session.record(change),
      onToolRun: toolLog && ((run) => toolLog.write(run)),
      ...hooks,
    });
  };

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
    project: projectView(project, cwd),
    switchProject: (folder) => {
      const dir = resolveFolder(folder, project.cwd);
      project = loadProject(dir);
      sandbox.readOnlyPaths = project.skills.map((s) => s.dir);
      return projectView(project, dir);
    },
    configFile: config.file,
    warnings,
    rememberedModel: (baseURL) => loadPreferences().models?.[baseURL],
    sandbox,
    sessions: {
      currentId: () => session.id,
      currentName: () => session.name,
      list: (everywhere) => listSessions(everywhere ? undefined : project.cwd, 50),
      open: (id) => {
        const opened = Session.open(id);
        session = opened.session;
        return { messages: opened.messages, model: session.model, endpoint: session.endpoint, cwd: session.cwd };
      },
      rename: (name) => session.rename(name),
      startNew: (model, endpoint) => {
        session = Session.create(project.cwd, model, endpoint);
      },
      recentProjects: () => {
        const byFolder = new Map<string, { cwd: string; sessions: number; updated: Date }>();
        for (const s of listSessions(undefined, 200)) {
          const entry = byFolder.get(s.cwd);
          if (entry) entry.sessions++;
          else byFolder.set(s.cwd, { cwd: s.cwd, sessions: 1, updated: s.updated });
        }
        return [...byFolder.values()];
      },
    },
    resumed: history,
    savePreferences: ({ server, model, reasoning }) => {
      if (model) session.recordModel(model, server.name);
      savePreferences({
        reasoning,
        endpoint: model ? server.name : undefined,
        model: model ? { baseURL: server.baseURL, id: model } : undefined,
      });
    },
  }).run();
  const resumeWith = session.name && !/\s/.test(session.name) ? session.name : session.id;
  console.log(`${FAREWELL}\nSession ${session.name ? `"${session.name}" ` : ""}${session.id}. Resume with: agent --resume ${resumeWith}`);
}

interface Project {
  cwd: string;
  instructions: InstructionFile[];
  skills: Skill[];
  tools: ToolDef[];
  warnings: string[];
}

/** Everything that depends on the folder being worked in. */
function loadProject(cwd: string): Project {
  const instructions = loadInstructions(cwd);
  const { skills, warnings } = loadSkills(skillRoots(findRepoRoot(cwd) ?? cwd));
  const tools = skills.length ? [...defaultTools, createSkillTool(skills)] : defaultTools;
  return { cwd, instructions, skills, tools, warnings };
}

function projectView(project: Project, cwd: string): ProjectView {
  return {
    cwd: project.cwd,
    instructions: project.instructions.map((f) => displayPath(f.path, cwd)),
    skills: project.skills,
    tools: project.tools,
    warnings: project.warnings,
  };
}

/** An existing folder, given relative to `base`, absolute, or with ~/. */
function resolveFolder(folder: string, base: string): string {
  const expanded = folder === "~" || folder.startsWith("~/") ? path.join(os.homedir(), folder.slice(1)) : folder;
  const dir = path.resolve(base, expanded);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Not a folder: ${folder}`);
  return dir;
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

/** Every saved session (or one folder's): name, where it is, when, how long, which model. */
function printSessions(cwd: string | undefined): void {
  const sessions = listSessions(cwd);
  if (sessions.length === 0) {
    console.log(cwd ? "No saved sessions for this folder." : "No saved sessions yet.");
    return;
  }
  const rows = sessions.map((s) => [
    s.name,
    shortPath(s.cwd, 40),
    s.updated.toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
    String(s.turns),
    s.endpoint ? `${s.endpoint}/${s.model}` : s.model,
    s.id,
  ]);
  const header = ["NAME", "FOLDER", "LAST USED", "MSGS", "MODEL", "ID"];
  const widths = header.map((h, i) => Math.min(i < 2 ? 48 : 40, Math.max(h.length, ...rows.map((r) => r[i]!.length))));
  const fit = (cells: string[]) => cells.map((c, i) => (c.length > widths[i]! ? `${c.slice(0, widths[i]! - 1)}…` : c.padEnd(widths[i]!))).join("  ").trimEnd();
  console.log(fit(header));
  for (const row of rows) console.log(fit(row));
  console.log(`\n${sessions.length} session${sessions.length === 1 ? "" : "s"}. Resume one with: agent --resume <id or name>`);
}

async function runHeadless(
  createAgent: (hooks: AgentHooks) => Agent,
  prompt: string,
  allowAll: boolean,
  baseURL: string,
): Promise<void> {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());

  let toolCalls = 0;
  let reason: string | undefined;
  const onEvent = (event: AgentEvent) => {
    if (event.type === "tool_end") toolCalls++;
    if (event.type === "done") reason = event.reason;
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

  const started = Date.now();
  try {
    await agent.send(prompt, controller.signal);
  } catch (err) {
    process.stderr.write(`${describeError(err, baseURL)}\n`);
    process.exitCode = 1;
  }
  process.stderr.write(`[${turnSummary(reason, Date.now() - started, toolCalls)}]\n`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
