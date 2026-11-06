/** "40ms", "4.2s", "42s", "1m 05s", "1h 02m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** The line shown when a turn ends, e.g. "Done in 1m 23s · 7 tool calls". */
export function turnSummary(reason: string | undefined, ms: number, toolCalls: number): string {
  const took = formatDuration(ms);
  const head =
    reason === "stop" ? `Done in ${took}`
    : reason === "interrupted" ? `Interrupted after ${took}`
    : reason === "max_steps" ? `Stopped at the step limit after ${took}`
    : reason === "length" ? `Cut off after ${took}`
    : `Stopped after ${took}`;
  return toolCalls > 0 ? `${head} · ${toolCalls} tool call${toolCalls === 1 ? "" : "s"}` : head;
}
