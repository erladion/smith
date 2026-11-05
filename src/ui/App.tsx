import { Box, Static, Text, useApp, useInput } from "ink";
import { useCallback, useRef, useState } from "react";
import type { Agent, ApprovalDecision, ApprovalRequest } from "../core/agent.js";
import { type Endpoint, EXAMPLE_CONFIG } from "../core/config.js";
import type { AgentEvent, BlockKind } from "../core/events.js";
import type { Message } from "../core/history.js";
import { isReasoningLevel, REASONING_HINTS, REASONING_LEVELS, type ReasoningLevel } from "../core/reasoning.js";
import type { Sandbox } from "../core/sandbox.js";
import { Server } from "../core/server.js";
import type { ToolDef } from "../core/tool.js";
import { type Entry, EntryView, type NewEntry, StreamedText } from "./entries.js";
import { describeError } from "../core/errors.js";
import { Picker, type PickerItem } from "./Picker.js";
import { historyToEntries } from "./replay.js";
import { Spinner, TextInput } from "./widgets.js";

export interface AgentHooks {
  onEvent: (event: AgentEvent) => void;
  approve: (req: ApprovalRequest) => Promise<ApprovalDecision>;
}

export interface PreferenceUpdate {
  server: Server;
  model?: string;
  reasoning?: ReasoningLevel;
}

interface Props {
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
  /** Remembers the user's endpoint, model and reasoning choices for next time. */
  savePreferences: (update: PreferenceUpdate) => void;
}

interface LiveBlock {
  kind: BlockKind;
  text: string;
  /** True once earlier paragraphs of this block were moved to the transcript. */
  continued: boolean;
}

interface PendingApproval extends ApprovalRequest {
  resolve: (decision: ApprovalDecision) => void;
}

interface OpenPicker {
  kind: "endpoint" | "model" | "reasoning";
  title: string;
  items: PickerItem[];
  current: string;
}

const HELP = `Commands:
  /endpoint [name]    pick a configured endpoint, or switch to one by name
  /model [name]       pick a model from the server, or switch to one by name
  /reasoning [level]  pick how much the model thinks: ${REASONING_LEVELS.join(", ")}
  /network on|off     allow or block network access for sandboxed commands
  /compact            summarize the conversation now to free context
  /clear              start the conversation over
  /exit               quit
Keys: esc interrupts the agent; ctrl+c quits.`;

export function App(props: Props) {
  const { createAgent, endpoints, configFile, sandbox, cwd, sessionId, resumed, tools, rememberedModel, savePreferences } = props;
  const [server, setServer] = useState(props.server);
  const { exit } = useApp();
  const nextId = useRef(1);
  const [live, setLive] = useState<LiveBlock | null>(null);
  const [activity, setActivity] = useState<string | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [picker, setPicker] = useState<OpenPicker | null>(null);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [context, setContext] = useState<{ tokens: number; limit?: number } | null>(null);
  const [network, setNetwork] = useState(sandbox.network);

  // The agent is created once, so its callbacks may only touch refs and setters.
  const liveRef = useRef<LiveBlock | null>(null);
  const approvalRef = useRef<PendingApproval | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const push = useCallback((entry: NewEntry) => {
    const withId = { ...entry, id: nextId.current++ } as Entry;
    setEntries((prev) => [...prev, withId]);
  }, []);

  const setLiveBlock = useCallback((block: LiveBlock | null) => {
    liveRef.current = block;
    setLive(block);
  }, []);

  /** Moves the live block into the static transcript. */
  const flushLive = useCallback(() => {
    const block = liveRef.current;
    if (block && block.text.trim()) {
      push({ kind: block.kind, text: block.text.trimEnd(), continued: block.continued });
    }
    setLiveBlock(null);
  }, [push, setLiveBlock]);

  const appendDelta = useCallback(
    (kind: BlockKind, text: string) => {
      let block = liveRef.current;
      if (block && block.kind !== kind) {
        flushLive();
        block = null;
      }
      let next = block ? block.text + text : text.trimStart();
      let continued = block?.continued ?? false;

      // Keep the live (re-rendered) region small: finished paragraphs move to
      // <Static>, which Ink prints once and never redraws.
      const cut = next.lastIndexOf("\n\n");
      if (cut > 0) {
        push({ kind, text: next.slice(0, cut).trimEnd(), continued });
        next = next.slice(cut + 2);
        continued = true;
      }
      setLiveBlock({ kind, text: next, continued });
    },
    [flushLive, push, setLiveBlock],
  );

  const onEvent = useCallback(
    (event: AgentEvent) => {
      switch (event.type) {
        case "delta":
          setActivity(null);
          appendDelta(event.kind, event.text);
          break;
        case "response_end":
          flushLive();
          break;
        case "tool_prepare":
          flushLive();
          setActivity(`Preparing ${event.name}…`);
          break;
        case "tool_start":
          setActivity(`${event.name} ${event.summary}`);
          break;
        case "tool_end":
          setActivity("Thinking…");
          push({ kind: "tool", name: event.name, summary: event.summary, output: event.output, isError: event.isError });
          break;
        case "context":
          setContext({ tokens: event.tokens, limit: event.limit });
          break;
        case "activity":
          setActivity(event.text);
          break;
        case "notice":
          flushLive();
          push({ kind: "notice", level: event.level, text: event.text });
          break;
        case "done":
          if (event.reason === "interrupted") push({ kind: "notice", level: "warn", text: "Interrupted." });
          break;
      }
    },
    [appendDelta, flushLive, push],
  );

  const approve = useCallback((req: ApprovalRequest) => {
    return new Promise<ApprovalDecision>((resolve) => {
      const pending = { ...req, resolve };
      approvalRef.current = pending;
      setApproval(pending);
    });
  }, []);

  const agentRef = useRef<Agent | null>(null);
  agentRef.current ??= createAgent({ onEvent, approve });
  const agent = agentRef.current;
  const [model, setModel] = useState(agent.model);
  const [reasoning, setReasoning] = useState(agent.reasoning);

  const [entries, setEntries] = useState<Entry[]>(() => [
    {
      id: 0,
      kind: "banner",
      model: agent.model,
      baseURL: server.label,
      cwd,
      session: sessionId,
      resumed: resumed.length > 0,
      sandbox: { active: sandbox.active, description: sandbox.describe() },
    },
    ...props.warnings.map((text) => ({ id: nextId.current++, kind: "notice", level: "warn", text }) as Entry),
    ...historyToEntries(resumed, tools).map((e) => ({ ...e, id: nextId.current++ }) as Entry),
  ]);

  const decide = useCallback((decision: ApprovalDecision) => {
    const pending = approvalRef.current;
    approvalRef.current = null;
    setApproval(null);
    pending?.resolve(decision);
  }, []);

  useInput((ch, key) => {
    if (approvalRef.current) {
      if (ch === "y") decide("allow");
      else if (ch === "a") decide("allow_always");
      else if (ch === "n") decide("deny");
      else if (key.escape) {
        decide("deny");
        abortRef.current?.abort();
      }
      return;
    }
    if (key.escape && abortRef.current) abortRef.current.abort();
  });

  /** Runs agent work with the spinner on and esc wired to interrupt it. */
  const runBusy = async (initialActivity: string, work: (signal: AbortSignal) => Promise<void>) => {
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setActivity(initialActivity);
    try {
      await work(controller.signal);
    } catch (err) {
      flushLive();
      push({ kind: "notice", level: "error", text: describeError(err, server.baseURL) });
    } finally {
      flushLive();
      abortRef.current = null;
      setActivity(null);
      setBusy(false);
    }
  };

  const switchModel = async (id: string) => {
    setBusy(true);
    setActivity(`Checking ${id}…`);
    const contextSize = await server.contextSize(id);
    agent.setModel(id, contextSize);
    setModel(id);
    savePreferences({ server, model: id });
    const window = contextSize ? `${contextSize.toLocaleString()}-token context` : "context size unknown";
    push({ kind: "notice", level: "info", text: `Switched to ${id} (${window}).` });
    setActivity(null);
    setBusy(false);
  };

  const switchReasoning = (level: ReasoningLevel) => {
    agent.setReasoning(level);
    setReasoning(level);
    savePreferences({ server, reasoning: level });
    push({ kind: "notice", level: "info", text: `Reasoning: ${level} (${REASONING_HINTS[level]}).` });
  };

  const openModelPicker = async () => {
    setBusy(true);
    setActivity("Loading models…");
    try {
      const models = await server.listModels(true);
      if (models.length === 0) {
        push({ kind: "notice", level: "warn", text: "The server lists no models. Use /model <name> to set one directly." });
        return;
      }
      setPicker({
        kind: "model",
        title: "Select a model",
        current: agent.model,
        items: models.map((m) => ({
          value: m.id,
          label: m.id,
          hint: m.contextSize ? `${m.contextSize.toLocaleString()} ctx` : undefined,
        })),
      });
    } catch (err) {
      push({ kind: "notice", level: "error", text: describeError(err, server.baseURL) });
    } finally {
      setActivity(null);
      setBusy(false);
    }
  };

  const switchEndpoint = async (name: string) => {
    const endpoint = endpoints.find((e) => e.name === name);
    if (!endpoint) {
      const known = endpoints.map((e) => e.name).join(", ") || "none";
      push({ kind: "notice", level: "error", text: `Unknown endpoint "${name}". Configured: ${known}.` });
      return;
    }
    setBusy(true);
    setActivity(`Connecting to ${name}…`);
    try {
      const next = Server.fromEndpoint(endpoint);
      const model = await next.chooseModel([rememberedModel(next.baseURL)]);
      const contextSize = await next.contextSize(model);
      agent.setModel(model, contextSize, next.client);
      setServer(next);
      setModel(model);
      savePreferences({ server: next, model });
      const window = contextSize ? `${contextSize.toLocaleString()}-token context` : "context size unknown";
      push({ kind: "notice", level: "info", text: `Connected to ${next.label}, using ${model} (${window}).` });
    } catch (err) {
      push({ kind: "notice", level: "error", text: `Could not switch to ${name}: ${describeError(err, endpoint.baseURL)}` });
    } finally {
      setActivity(null);
      setBusy(false);
    }
  };

  const openEndpointPicker = () => {
    if (endpoints.length === 0) {
      push({
        kind: "notice",
        level: "info",
        text: `No endpoints are configured. Add them to ${configFile}, for example:\n${EXAMPLE_CONFIG}`,
      });
      return;
    }
    setPicker({
      kind: "endpoint",
      title: "Select an endpoint",
      current: server.name ?? "",
      items: endpoints.map((e) => ({
        value: e.name,
        label: e.name,
        hint: e.model ? `${e.baseURL} · ${e.model}` : e.baseURL,
      })),
    });
  };

  const onPick = (value: string) => {
    const open = picker;
    setPicker(null);
    if (open?.kind === "endpoint" && value !== server.name) void switchEndpoint(value);
    if (open?.kind === "model" && value !== agent.model) void switchModel(value);
    if (open?.kind === "reasoning" && isReasoningLevel(value) && value !== agent.reasoning) switchReasoning(value);
  };

  const submit = async (value: string) => {
    const text = value.trim();
    if (!text || busy) return;
    setInput("");

    if (text.startsWith("/")) {
      const [command, ...rest] = text.split(/\s+/);
      const arg = rest.join(" ");
      switch (command) {
        case "/exit":
        case "/quit":
          exit();
          return;
        case "/help":
          push({ kind: "notice", level: "info", text: HELP });
          return;
        case "/clear":
          agent.reset();
          setContext(null);
          push({ kind: "notice", level: "info", text: "Conversation cleared." });
          return;
        case "/network":
          if (!sandbox.active) {
            push({ kind: "notice", level: "warn", text: `There is no sandbox, so commands already have full network access (${sandbox.reason}).` });
          } else if (arg === "on" || arg === "off") {
            sandbox.network = arg === "on";
            setNetwork(sandbox.network);
            push({ kind: "notice", level: "info", text: `Sandboxed commands now have network ${arg}.` });
          } else {
            push({ kind: "notice", level: "info", text: `Network is ${sandbox.network ? "on" : "off"} for sandboxed commands. Use /network on or /network off.` });
          }
          return;
        case "/compact":
          await runBusy("Compacting…", (signal) => agent.compactNow(signal));
          return;
        case "/endpoint":
          if (arg) await switchEndpoint(arg);
          else openEndpointPicker();
          return;
        case "/model":
          if (arg) await switchModel(arg);
          else await openModelPicker();
          return;
        case "/reasoning":
          if (!arg) {
            setPicker({
              kind: "reasoning",
              title: "Select reasoning level",
              current: agent.reasoning,
              items: REASONING_LEVELS.map((l) => ({ value: l, label: l, hint: REASONING_HINTS[l] })),
            });
          } else if (isReasoningLevel(arg)) {
            switchReasoning(arg);
          } else {
            push({ kind: "notice", level: "error", text: `Unknown reasoning level "${arg}". Use one of: ${REASONING_LEVELS.join(", ")}.` });
          }
          return;
        default:
          push({ kind: "notice", level: "error", text: `Unknown command ${command}. Type /help for the list.` });
          return;
      }
    }

    push({ kind: "user", text });
    await runBusy("Thinking…", (signal) => agent.send(text, signal));
  };

  const contextLabel = context
    ? context.limit
      ? ` · ${context.tokens.toLocaleString()} / ${context.limit.toLocaleString()} tokens (${Math.round((100 * context.tokens) / context.limit)}%)`
      : ` · ${context.tokens.toLocaleString()} tokens`
    : "";

  return (
    <>
      <Static items={entries}>{(entry) => <EntryView key={entry.id} entry={entry} />}</Static>

      {live && <StreamedText text={live.text} continued={live.continued} reasoning={live.kind === "reasoning"} />}

      {activity && !approval && (
        <Box marginTop={1}>
          <Text color="yellow">
            <Spinner />
          </Text>
          <Text dimColor> {activity}</Text>
        </Box>
      )}

      {approval && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold>Allow {approval.tool}?</Text>
          <Text>{approval.summary}</Text>
          {approval.sandbox && (
            <Text color={approval.sandbox.active ? "green" : "red"}>
              {approval.sandbox.active ? "✓ " : "⚠ "}
              {approval.sandbox.description}
            </Text>
          )}
          <Text dimColor>
            <Text color="green">y</Text> yes · <Text color="green">a</Text> always allow {approval.tool} this session ·{" "}
            <Text color="red">n</Text> no · <Text color="red">esc</Text> no and interrupt
          </Text>
        </Box>
      )}

      {picker && (
        <Picker
          key={picker.kind}
          title={picker.title}
          items={picker.items}
          current={picker.current}
          onSelect={onPick}
          onCancel={() => setPicker(null)}
        />
      )}

      {!busy && !picker && (
        <Box marginTop={1} borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="cyan">{"› "}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder="Ask for something, or /help" />
        </Box>
      )}

      <Box paddingX={1}>
        {/* One Text, so a narrow terminal cuts the line off instead of wrapping each piece. */}
        <Text wrap="truncate-end">
          {/* The warning goes first so a narrow terminal never cuts it off. */}
          {!sandbox.active && <Text color="red">unsandboxed · </Text>}
          <Text dimColor>
            {server.name && `${server.name} · `}
            {model} · reasoning {reasoning}
            {contextLabel}
            {sandbox.active && ` · sandbox, net ${network ? "on" : "off"}`}
            {busy && " · esc to interrupt"}
          </Text>
        </Text>
      </Box>
    </>
  );
}
