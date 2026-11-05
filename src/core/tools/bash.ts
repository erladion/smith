import { spawn } from "node:child_process";
import { z } from "zod";
import { Sandbox } from "../sandbox.js";
import { defineTool, truncate } from "../tool.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 20_000;
// Stop buffering far past what we would show, so a runaway command can't eat memory.
const MAX_CAPTURE_CHARS = 1_000_000;

export const bash = defineTool({
  name: "bash",
  description:
    "Run a shell command with bash in the working directory and return its combined stdout and stderr. " +
    "Commands run non-interactively with no stdin, so avoid commands that prompt for input. " +
    `Times out after ${DEFAULT_TIMEOUT_MS / 1000}s unless timeout_ms is set.`,
  schema: z.object({
    command: z.string().min(1).describe("The command to run"),
    timeout_ms: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional().describe("Timeout in milliseconds"),
  }),
  readOnly: false,
  sandboxed: true,
  summarize: ({ command }) => command,
  run: ({ command, timeout_ms = DEFAULT_TIMEOUT_MS }, ctx) =>
    new Promise((resolve) => {
      const spec = (ctx.sandbox ?? Sandbox.none()).spawnSpec(command, ctx.cwd);
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
        const body = truncate(output.trimEnd(), MAX_OUTPUT_CHARS) || "(no output)";
        if (stoppedBy === "timeout") {
          finish({ content: `${body}\n\n[Command timed out after ${timeout_ms}ms and was killed]`, isError: true });
        } else if (stoppedBy === "interrupt") {
          finish({ content: `${body}\n\n[Command interrupted by the user]`, isError: true });
        } else if (code !== 0) {
          finish({ content: `${body}\n\n[Exit code ${code}]`, isError: true });
        } else {
          finish({ content: body });
        }
      });
    }),
});
