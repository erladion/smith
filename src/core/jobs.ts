import { type ChildProcess, spawn } from "node:child_process";
import type { SpawnSpec } from "./sandbox.js";

// Keep at most this much of a job's output; older output is dropped.
const MAX_BUFFER_CHARS = 1_000_000;

export interface JobStatus {
  id: string;
  command: string;
  running: boolean;
  /** Exit code once it has ended; null if a signal ended it. */
  exitCode: number | null;
  /** The signal that ended it, e.g. SIGKILL after a stop. */
  signal: string | null;
  started: Date;
}

interface Job extends JobStatus {
  child: ChildProcess;
  spec: SpawnSpec;
  output: string;
  /** Characters dropped from the start of `output` to keep it small. */
  dropped: number;
  /** How far the model has read, counted from the very start of the output. */
  read: number;
  exited: Promise<void>;
  /** Called whenever output arrives, for waiters. */
  onOutput: Set<() => void>;
}

/**
 * Shell commands the agent started in the background (dev servers,
 * watchers, long builds). They run in the same sandbox as other commands,
 * outlive the tool call and the turn, and are stopped when the conversation
 * changes or Smith exits.
 */
export class BackgroundJobs {
  private readonly jobs = new Map<string, Job>();
  private next = 1;
  /** Called when a job starts or ends, e.g. to update the status line. */
  onChange: () => void = () => {};

  constructor() {
    process.once("exit", () => this.stopAll());
  }

  /** Starts a command from its spawn spec; its output collects until read. */
  start(command: string, spec: SpawnSpec, cwd: string): JobStatus {
    // detached: its own process group, so a stop ends everything it spawned.
    const child = spawn(spec.file, spec.args, { cwd: spec.cwd ?? cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    let exited!: () => void;
    const job: Job = {
      id: `bg${this.next++}`,
      command,
      running: true,
      exitCode: null,
      signal: null,
      started: new Date(),
      child,
      spec,
      output: "",
      dropped: 0,
      read: 0,
      exited: new Promise((resolve) => (exited = resolve)),
      onOutput: new Set(),
    };
    const collect = (chunk: Buffer) => {
      job.output += chunk.toString("utf8");
      const excess = job.output.length - MAX_BUFFER_CHARS;
      if (excess > 0) {
        job.output = job.output.slice(excess);
        job.dropped += excess;
      }
      for (const wake of job.onOutput) wake();
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const end = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!job.running) return;
      job.running = false;
      job.exitCode = code;
      job.signal = signal;
      exited();
      this.onChange();
    };
    child.on("close", end);
    child.on("error", (err) => {
      collect(Buffer.from(`Failed to start ${spec.file}: ${err.message}\n`));
      end(127, null);
    });
    this.jobs.set(job.id, job);
    this.onChange();
    return status(job);
  }

  list(): JobStatus[] {
    return [...this.jobs.values()].map(status);
  }

  /** How many are still running. */
  get running(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.running) n++;
    return n;
  }

  /**
   * Output since the last read, and the job's state. With `waitMs`, first
   * waits up to that long for the job to end, or, with `until`, for new
   * output matching it (e.g. a server's "listening on"); `signal` cuts the
   * wait short. With `peek`, the output stays unread.
   */
  async read(
    id: string,
    opts: { waitMs?: number; until?: RegExp; signal?: AbortSignal; peek?: boolean } = {},
  ): Promise<{ status: JobStatus; output: string; dropped: number; matched: boolean }> {
    const job = this.get(id);
    const { waitMs = 0, until, signal, peek = false } = opts;
    const fresh = () => job.output.slice(Math.max(0, job.read - job.dropped));
    let matched = until ? until.test(fresh()) : false;
    if (waitMs > 0 && job.running && !matched) {
      let timer: NodeJS.Timeout | undefined;
      let wake: () => void = () => {};
      await Promise.race([
        job.exited,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          wake = () => {
            if (until?.test(fresh())) resolve();
          };
          if (until) job.onOutput.add(wake);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      clearTimeout(timer);
      job.onOutput.delete(wake);
      matched = until ? until.test(fresh()) : false;
    }
    const dropped = Math.max(0, job.dropped - job.read);
    const output = fresh();
    if (!peek) job.read = job.dropped + job.output.length;
    return { status: status(job), output, dropped, matched };
  }

  /** Stops a job and everything it started. Resolves once it has ended. */
  async stop(id: string): Promise<JobStatus> {
    const job = this.get(id);
    if (job.running) {
      kill(job);
      await Promise.race([job.exited, new Promise((r) => setTimeout(r, 5_000))]);
    }
    return status(job);
  }

  /** Stops every job at once, without waiting; returns how many were running. */
  stopAll(): number {
    let stopped = 0;
    for (const job of this.jobs.values()) {
      if (!job.running) continue;
      kill(job);
      stopped++;
    }
    return stopped;
  }

  /** Stops every job and forgets them all, e.g. for a new conversation. */
  clear(): number {
    const stopped = this.stopAll();
    this.jobs.clear();
    this.next = 1;
    this.onChange();
    return stopped;
  }

  private get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) {
      const known = [...this.jobs.keys()];
      throw new Error(`No background job ${id}. ${known.length ? `Jobs: ${known.join(", ")}.` : "None have been started."}`);
    }
    return job;
  }
}

/** Kills the job's process group here, and inside a container too. */
function kill(job: Job): void {
  try {
    if (job.child.pid) process.kill(-job.child.pid, "SIGKILL");
  } catch {
    // Already gone.
  }
  job.spec.kill?.();
}

function status({ id, command, running, exitCode, signal, started }: Job): JobStatus {
  return { id, command, running, exitCode, signal, started };
}

/** "running", "exited with code 0", "stopped (SIGKILL)". */
export function describeJob(job: JobStatus): string {
  if (job.running) return "running";
  if (job.signal) return `stopped (${job.signal})`;
  return `exited with code ${job.exitCode}`;
}
