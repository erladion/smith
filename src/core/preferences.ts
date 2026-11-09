import fs from "node:fs";
import path from "node:path";
import { configDir } from "./dirs.js";
import { privateDir, privateFile } from "./private.js";
import { isReasoningLevel, type ReasoningLevel } from "./reasoning.js";

/** Choices remembered between runs. Models are per server, since each serves its own set. */
export interface Preferences {
  reasoning?: ReasoningLevel;
  /** Name of the endpoint used last. */
  endpoint?: string;
  models?: Record<string, string>;
}

function file(): string {
  return path.join(configDir(), "preferences.json");
}

export function loadPreferences(): Preferences {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Preferences;
    return {
      reasoning: raw.reasoning && isReasoningLevel(raw.reasoning) ? raw.reasoning : undefined,
      endpoint: typeof raw.endpoint === "string" ? raw.endpoint : undefined,
      models: raw.models && typeof raw.models === "object" ? raw.models : undefined,
    };
  } catch {
    return {};
  }
}

export function savePreferences(update: {
  reasoning?: ReasoningLevel;
  endpoint?: string;
  model?: { baseURL: string; id: string };
}): void {
  const prefs = loadPreferences();
  if (update.reasoning) prefs.reasoning = update.reasoning;
  if (update.endpoint) prefs.endpoint = update.endpoint;
  if (update.model) prefs.models = { ...prefs.models, [update.model.baseURL]: update.model.id };
  try {
    privateDir(path.dirname(file()));
    fs.writeFileSync(file(), JSON.stringify(prefs, null, 2) + "\n", { mode: 0o600 });
    privateFile(file());
  } catch {
    // Preferences are a convenience; failing to save them shouldn't break anything.
  }
}
