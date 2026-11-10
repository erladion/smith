import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { configDir } from "./dirs.js";
import type { ContainerSettings, Limits } from "./sandbox.js";
import { z } from "zod";

/**
 * ~/.config/smith/config.json: named endpoints you can switch between.
 *
 *   {
 *     "default": "local",
 *     "maxSteps": 50,
 *     "endpoints": {
 *       "local": { "baseURL": "http://localhost:8080/v1" },
 *       "gpu-box": {
 *         "baseURL": "http://10.0.0.5:8000/v1",
 *         "apiKeyEnv": "GPU_BOX_KEY",
 *         "model": "qwen3-coder-30b",
 *         "contextSize": 65536
 *       }
 *     }
 *   }
 *
 * This file is only read, never written, so hand edits are safe.
 */

const EndpointSchema = z
  .strictObject({
    baseURL: z.url().describe("OpenAI-compatible base URL, usually ending in /v1"),
    apiKey: z.string().optional().describe("API key, stored in this file"),
    apiKeyEnv: z.string().optional().describe("Name of an environment variable holding the API key"),
    model: z.string().optional().describe("Model to use when none was used on this endpoint before"),
    contextSize: z.number().int().positive().optional().describe("Context window, for servers that don't report it"),
  })
  .refine((e) => !(e.apiKey && e.apiKeyEnv), "set apiKey or apiKeyEnv, not both");

const SIZE = /^(\d+(?:\.\d+)?)\s*([kmgt]?)i?b?$/i;

const SandboxSchema = z.strictObject({
  type: z.enum(["bwrap", "container"]).optional().describe("bwrap (default) or container; --sandbox off is only ever per run"),
  network: z.boolean().optional().describe("Let commands use the network from the start (default false)"),
  env: z
    .array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*(=.*)?$/s, '"NAME" or "NAME=value"'))
    .optional()
    .describe('More environment variables for commands: "NAME" passes it through, "NAME=value" sets it'),
  limits: z
    .strictObject({
      memory: z.string().regex(SIZE, 'a size such as "8g" or "512m"').optional(),
      processes: z.number().int().positive().optional(),
      cpus: z.number().positive().optional(),
    })
    .optional(),
  home: z
    .strictObject({
      show: z.array(z.string()).optional().describe("Home folders shown read-only in the bwrap sandbox"),
      writable: z.array(z.string()).optional().describe("Home folders shown read-write, e.g. build caches"),
    })
    .optional(),
  container: z
    .strictObject({
      runtime: z.enum(["podman", "docker"]).optional(),
      image: z.string().min(1).optional(),
      mounts: z.array(z.string().min(1)).optional(),
    })
    .optional(),
  projects: z.record(z.string(), z.strictObject({ image: z.string().min(1).optional(), mounts: z.array(z.string().min(1)).optional() })).optional(),
});

const ConfigSchema = z.strictObject({
  default: z.string().optional(),
  maxSteps: z.number().int().min(1).max(10_000).optional().describe("Model calls allowed per message before the agent stops"),
  subagents: z.boolean().optional().describe("Give the model the task tool for read-only sub-agents (default true)"),
  toolLog: z.boolean().optional().describe("Log every tool call to ~/.local/share/smith/logs (default true)"),
  theme: z.enum(["matrix", "plain"]).optional().describe("matrix: digital rain, katakana spinner and Agent Smith's lines (default); plain: none of it"),
  codeStream: z.boolean().optional().describe("With the matrix theme, a stream of glyphs at the end of the status line while idle (default true)"),
  sandbox: SandboxSchema.optional(),
  protectRunLater: z.boolean().optional().describe("Always ask before changing files that run outside the sandbox later, and report other changes (default true)"),
  endpoints: z.record(z.string(), EndpointSchema).default({}),
});

/** The image used in container mode when the config names none. */
export const DEFAULT_IMAGE = "registry.access.redhat.com/ubi9/ubi:latest";

/** The sandbox settings, with defaults filled in and ~ expanded. */
export interface SandboxConfig {
  type: "bwrap" | "container";
  network: boolean;
  env: string[];
  limits?: Limits;
  home: { show: string[]; writable: string[] };
  container: ContainerSettings;
}

export interface Endpoint {
  name: string;
  baseURL: string;
  apiKey?: string;
  model?: string;
  contextSize?: number;
}

/** How the TUI looks: "matrix" adds digital rain at startup and a katakana spinner. */
export type Theme = "matrix" | "plain";

export interface Config {
  file: string;
  endpoints: Endpoint[];
  defaultEndpoint?: string;
  /** Model calls allowed per message you send. */
  maxSteps?: number;
  /** Whether the model gets the task tool (sub-agents). */
  subagents: boolean;
  /** Whether tool calls are logged to logs/<session>.jsonl. */
  toolLog: boolean;
  theme: Theme;
  /** Whether the matrix theme shows the idle stream of glyphs in the status line. */
  codeStream: boolean;
  sandbox: SandboxConfig;
  /** Whether changes to files that run outside the sandbox later always ask, and are reported. */
  protectRunLater: boolean;
  /** Problems worth telling the user about that don't stop the agent. */
  warnings: string[];
}

export const EXAMPLE_CONFIG = `{
  "default": "local",
  "maxSteps": 50,
  "endpoints": {
    "local": { "baseURL": "http://localhost:8080/v1" },
    "gpu-box": {
      "baseURL": "http://10.0.0.5:8000/v1",
      "apiKeyEnv": "GPU_BOX_KEY",
      "model": "qwen3-coder-30b",
      "contextSize": 65536
    }
  }
}`;

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

/** Loads the config file. A missing file means no endpoints; an invalid one is an error. */
export function loadConfig(file = configPath()): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { file, endpoints: [], subagents: true, toolLog: true, theme: "matrix", codeStream: true, sandbox: sandboxConfig(undefined), protectRunLater: true, warnings: [] };
    }
    throw err;
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid ${file}:\n${z.prettifyError(parsed.error)}`);
  const config = parsed.data;

  if (config.default && !config.endpoints[config.default]) {
    throw new Error(`${file}: the default endpoint "${config.default}" is not defined under "endpoints".`);
  }

  const warnings: string[] = [];
  const endpoints = Object.entries(config.endpoints).map(([name, e]): Endpoint => {
    let apiKey = e.apiKey;
    if (e.apiKeyEnv) {
      apiKey = process.env[e.apiKeyEnv];
      if (!apiKey) warnings.push(`Endpoint "${name}": the environment variable ${e.apiKeyEnv} is not set.`);
    }
    return { name, baseURL: e.baseURL, apiKey, model: e.model, contextSize: e.contextSize };
  });

  const storesKeys = Object.values(config.endpoints).some((e) => e.apiKey);
  if (storesKeys && (fs.statSync(file).mode & 0o077) !== 0) {
    warnings.push(`${file} contains API keys but other users can read it. Run: chmod 600 ${file}`);
  }

  return { file, endpoints, defaultEndpoint: config.default, maxSteps: config.maxSteps, subagents: config.subagents ?? true, toolLog: config.toolLog ?? true, theme: config.theme ?? "matrix", codeStream: config.codeStream ?? true, sandbox: sandboxConfig(config.sandbox), protectRunLater: config.protectRunLater ?? true, warnings };
}

function sandboxConfig(raw: z.output<typeof SandboxSchema> | undefined): SandboxConfig {
  const limits = raw?.limits && { memory: raw.limits.memory ? parseSize(raw.limits.memory) : undefined, processes: raw.limits.processes, cpus: raw.limits.cpus };
  return {
    type: raw?.type ?? "bwrap",
    network: raw?.network ?? false,
    env: raw?.env ?? [],
    limits,
    home: { show: (raw?.home?.show ?? []).map(homePath), writable: (raw?.home?.writable ?? []).map(homePath) },
    container: {
      runtime: raw?.container?.runtime ?? "podman",
      image: raw?.container?.image ?? DEFAULT_IMAGE,
      mounts: raw?.container?.mounts ?? [],
      projects: Object.entries(raw?.projects ?? {}).map(([folder, p]) => ({ folder: homePath(folder), image: p.image, mounts: p.mounts ?? [] })),
    },
  };
}

/** "~/x" or a path relative to the home folder, as an absolute path. */
function homePath(p: string): string {
  const expanded = p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
  return path.resolve(os.homedir(), expanded).replace(/\/+$/, "") || "/";
}

/** "8g", "512m", "1.5GB" or plain bytes, in bytes. */
export function parseSize(text: string): number {
  const match = SIZE.exec(text.trim());
  if (!match) throw new Error(`Not a size: ${text}`);
  const power = " kmgt".indexOf((match[2] || " ").toLowerCase());
  return Math.round(Number(match[1]) * 1024 ** power);
}
