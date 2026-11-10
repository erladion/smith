import type { BackgroundJobs } from "../jobs.js";
import type { ToolDef } from "../tool.js";
import { bash, createBashTool } from "./bash.js";
import { editFile, readFile, writeFile } from "./files.js";
import { createJobTools } from "./jobs.js";
import { glob, grep, list } from "./search.js";

/** The file, search and shell tools; bash without background jobs. */
export const defaultTools: ToolDef[] = [readFile, list, grep, glob, writeFile, editFile, bash];

/** The default tools, with bash able to run commands in the background as `jobs`. */
export function createDefaultTools(jobs: BackgroundJobs): ToolDef[] {
  return [readFile, list, grep, glob, writeFile, editFile, createBashTool(jobs), ...createJobTools(jobs)];
}
