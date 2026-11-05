import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isReasoningLevel, type ReasoningLevel } from "./reasoning.js";

/** Choices remembered between runs. Models are per server, since each serves its own set. */
export interface Preferences {
  reasoning?: ReasoningLevel;
  models?: Record<string, string>;
}

function file(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "agent", "preferences.json");
}

export function loadPreferences(): Preferences {
  try {
    const raw = JSON.parse(fs.readFileSync(file(), "utf8")) as Preferences;
    return {
      reasoning: raw.reasoning && isReasoningLevel(raw.reasoning) ? raw.reasoning : undefined,
      models: raw.models && typeof raw.models === "object" ? raw.models : undefined,
    };
  } catch {
    return {};
  }
}

export function savePreferences(update: { reasoning?: ReasoningLevel; model?: { baseURL: string; id: string } }): void {
  const prefs = loadPreferences();
  if (update.reasoning) prefs.reasoning = update.reasoning;
  if (update.model) prefs.models = { ...prefs.models, [update.model.baseURL]: update.model.id };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(prefs, null, 2) + "\n");
  } catch {
    // Preferences are a convenience; failing to save them shouldn't break anything.
  }
}
