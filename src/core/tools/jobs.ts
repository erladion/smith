import { z } from "zod";
import { type BackgroundJobs, describeJob } from "../jobs.js";
import { defineTool, type ToolDef, truncateLog } from "../tool.js";

const MAX_OUTPUT_CHARS = 20_000;
const MAX_WAIT_MS = 120_000;

/** bash_output and bash_kill, for commands bash started in the background. */
export function createJobTools(jobs: BackgroundJobs): ToolDef[] {
  const output = defineTool({
    name: "bash_output",
    description:
      "Read what a background job (started with bash's run_in_background) printed since you last read it, and " +
      "whether it's still running. wait_ms waits up to that long for the job to end first; with until, it stops " +
      'waiting as soon as new output matches that regular expression (e.g. "listening on|ready").',
    schema: z.object({
      id: z.string().min(1).describe('The job id, e.g. "bg1"'),
      wait_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().describe("How long to wait, in milliseconds"),
      until: z.string().min(1).optional().describe("Stop waiting when new output matches this regular expression"),
    }),
    readOnly: true,
    summarize: ({ id, wait_ms, until }) => [id, wait_ms && `waiting up to ${Math.round(wait_ms / 1000)}s`, until && `until /${until}/`].filter(Boolean).join(", "),
    async run({ id, wait_ms = 0, until }, ctx) {
      let pattern: RegExp | undefined;
      try {
        pattern = until ? new RegExp(until, "m") : undefined;
      } catch (err) {
        return { content: `until is not a valid regular expression: ${(err as Error).message}`, isError: true };
      }
      const { status, output, dropped, matched } = await jobs.read(id, { waitMs: wait_ms, until: pattern, signal: ctx.signal });
      const lost = dropped ? `[${dropped} earlier characters were dropped]\n` : "";
      const text = truncateLog(output.trimEnd(), MAX_OUTPUT_CHARS);
      const body = text ? `${lost}${text}` : `${lost}(no new output)`;
      const waited = pattern && status.running ? (matched ? `; the output matched /${until}/` : `; nothing matched /${until}/ yet`) : "";
      return { content: `${body}\n\n[Job ${id}: ${describeJob(status)}${waited}]` };
    },
  });

  const kill = defineTool({
    name: "bash_kill",
    description: "Stop a background job and everything it started. Stop the jobs you started once you no longer need them.",
    schema: z.object({ id: z.string().min(1).describe('The job id, e.g. "bg1"') }),
    // It only stops what the agent itself started, so it doesn't ask.
    readOnly: true,
    // Sub-agents can read a job's output, but not stop it.
    subagents: false,
    summarize: ({ id }) => id,
    async run({ id }) {
      const before = jobs.list().find((j) => j.id === id);
      if (before && !before.running) return { content: `Job ${id} had already ended (${describeJob(before)}).` };
      const status = await jobs.stop(id);
      return { content: `Stopped job ${id} (${describeJob(status)}).` };
    },
  });

  return [output, kill];
}
