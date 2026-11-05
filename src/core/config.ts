import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

/**
 * ~/.config/agent/config.json: named endpoints you can switch between.
 *
 *   {
 *     "default": "local",
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

const ConfigSchema = z.strictObject({
  default: z.string().optional(),
  endpoints: z.record(z.string(), EndpointSchema).default({}),
});

export interface Endpoint {
  name: string;
  baseURL: string;
  apiKey?: string;
  model?: string;
  contextSize?: number;
}

export interface Config {
  file: string;
  endpoints: Endpoint[];
  defaultEndpoint?: string;
  /** Problems worth telling the user about that don't stop the agent. */
  warnings: string[];
}

export const EXAMPLE_CONFIG = `{
  "default": "local",
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
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "agent", "config.json");
}

/** Loads the config file. A missing file means no endpoints; an invalid one is an error. */
export function loadConfig(file = configPath()): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { file, endpoints: [], warnings: [] };
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

  return { file, endpoints, defaultEndpoint: config.default, warnings };
}
