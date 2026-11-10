import { spawn } from "node:child_process";
import { z } from "zod";
import { describeJob, type BackgroundJobs } from "../jobs.js";
import { Sandbox, type SpawnSpec } from "../sandbox.js";
import { defineTool, type ToolContext, type ToolDef, type ToolResult, truncateLog } from "../tool.js";

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 20_000;
// Stop buffering far past what we would show, so a runaway command can't eat memory.
const MAX_CAPTURE_CHARS = 1_000_000;

const commandSchema = z.object({
  command: z.string().min(1).describe("The command to run"),
  timeout_ms: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional().describe("Timeout in milliseconds"),
});

const backgroundSchema = commandSchema.extend({
  run_in_background: z
    .boolean()
    .optional()
    .describe("Start it and return at once, for servers, watchers and long builds; read its output with bash_output"),
});

const DESCRIPTION =
  "Run a shell command with bash in the working directory and return its combined stdout and stderr. " +
  "Commands run non-interactively with no stdin, so avoid commands that prompt for input. " +
  `Times out after ${DEFAULT_TIMEOUT_MS / 1000}s unless timeout_ms is set.`;

/** The plain `bash` tool, without background jobs. */
export const bash = defineTool({
  name: "bash",
  description: DESCRIPTION,
  schema: commandSchema,
  readOnly: false,
  sandboxed: true,
  summarize: ({ command }) => command,
  run: (input, ctx) => runCommand(input, ctx),
});

/** `bash` that can also start commands in the background, as `jobs`. */
export function createBashTool(jobs: BackgroundJobs): ToolDef {
  return defineTool({
    name: "bash",
    description:
      `${DESCRIPTION} Set run_in_background for commands that keep running (dev servers, watchers) or take longer ` +
      "than the timeout; it returns a job id at once. Don't append & yourself.",
    schema: backgroundSchema,
    readOnly: false,
    sandboxed: true,
    summarize: ({ command, run_in_background }) => (run_in_background ? `${command} (in the background)` : command),
    async run(input, ctx) {
      if (!input.run_in_background) return runCommand(input, ctx);
      let spec: SpawnSpec;
      try {
        spec = await (ctx.sandbox ?? Sandbox.none()).spawnSpec(input.command, ctx.cwd);
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
      const job = jobs.start(input.command, spec, ctx.cwd);
      // A moment to catch commands that fail at once (a typo, a port in use).
      // A peek: what it printed stays unread, so bash_output (and its until) still sees it.
      const { status, output } = await jobs.read(job.id, { waitMs: 1_000, signal: ctx.signal, peek: true });
      const shown = truncateLog(output.trimEnd(), MAX_OUTPUT_CHARS);
      if (!status.running) {
        const failed = status.exitCode !== 0;
        const note = failed ? (ctx.sandbox ?? Sandbox.none()).explainFailure(output, ctx.cwd) : undefined;
        const body = `Background job ${job.id} ${describeJob(status)} right away.${shown ? `\n\n${shown}` : ""}${note ? `\n${note}` : ""}`;
        return { content: body, isError: failed };
      }
      const head = `Started background job ${job.id}. Read its output with bash_output (id "${job.id}"; wait_ms and until wait for it), and stop it with bash_kill when you're done.`;
      return { content: shown ? `${head}\n\nOutput so far:\n${shown}` : head };
    },
  });
}

/** Runs a command to completion (or its timeout) in the sandbox. */
async function runCommand({ command, timeout_ms = DEFAULT_TIMEOUT_MS }: z.output<typeof commandSchema>, ctx: ToolContext): Promise<ToolResult> {
  let spec: SpawnSpec;
  try {
    spec = await (ctx.sandbox ?? Sandbox.none()).spawnSpec(command, ctx.cwd);
  } catch (err) {
    // E.g. the container couldn't start.
    return { content: (err as Error).message, isError: true };
  }
  return new Promise((resolve) => {
    // detached puts the command in its own process group, so killing the
    // group also stops anything it spawned (pipelines, dev servers, ...).
    const child = spawn(spec.file, spec.args, {
      cwd: ctx.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < MAX_CAPTURE_CHARS) output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    let stoppedBy: "timeout" | "interrupt" | null = null;
    const kill = (reason: "timeout" | "interrupt") => {
      stoppedBy ??= reason;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already exited.
      }
      spec.kill?.();
    };
    const timer = setTimeout(() => kill("timeout"), timeout_ms);
    const onAbort = () => kill("interrupt");
    ctx.signal.addEventListener("abort", onAbort, { once: true });

    const finish = (result: { content: string; isError?: boolean }) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", (err) => finish({ content: `Failed to start ${spec.file}: ${err.message}`, isError: true }));
    child.on("close", (code) => {
      const body = truncateLog(output.trimEnd(), MAX_OUTPUT_CHARS) || "(no output)";
      if (stoppedBy === "timeout") {
        finish({ content: `${body}\n\n[Command timed out after ${timeout_ms}ms and was killed]`, isError: true });
      } else if (stoppedBy === "interrupt") {
        finish({ content: `${body}\n\n[Command interrupted by the user]`, isError: true });
      } else if (code !== 0) {
        // When it looks like the sandbox's doing, say so, or a model may "fix" code that was fine.
        const note = (ctx.sandbox ?? Sandbox.none()).explainFailure(output, ctx.cwd);
        finish({ content: `${body}\n\n[Exit code ${code}]${note ? `\n${note}` : ""}`, isError: true });
      } else {
        finish({ content: body });
      }
    });
  });
}
