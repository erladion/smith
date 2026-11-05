import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { resolveInRoot } from "../paths.js";
import type { Skill } from "../skills.js";
import { defineTool, type ToolDef, truncate } from "../tool.js";

const MAX_CHARS = 30_000;
const MAX_LISTED_FILES = 50;

/** The `skill` tool, for the skills found at startup. */
export function createSkillTool(skills: Skill[]): ToolDef {
  const byName = new Map(skills.map((s) => [s.name, s]));
  return defineTool({
    name: "skill",
    description:
      "Load a skill: packaged instructions for a kind of task. The available skills are listed in the " +
      "system prompt. Call this with a skill's name before starting a task that matches its description, " +
      "then follow its instructions. Pass file to read one of the skill's other files.",
    schema: z.object({
      name: z.string().describe("The skill's name"),
      file: z.string().optional().describe("A file inside the skill's folder, relative to it"),
    }),
    readOnly: true,
    summarize: ({ name, file }) => (file ? `${name}: ${file}` : name),
    async run({ name, file }) {
      const skill = byName.get(name);
      if (!skill) {
        return { content: `No skill named "${name}". Available: ${[...byName.keys()].join(", ")}.`, isError: true };
      }
      if (file) {
        const target = await resolveInRoot(skill.dir, file);
        return { content: truncate(await fs.readFile(target, "utf8"), MAX_CHARS) };
      }
      const others = (await listFiles(skill.dir)).filter((f) => f !== "SKILL.md");
      const listing = others.length
        ? `\n\nOther files in this skill (read them with file, or run scripts from ${skill.dir}):\n${others.map((f) => `- ${f}`).join("\n")}`
        : "";
      return { content: `Skill folder: ${skill.dir}\n\n${truncate(skill.body, MAX_CHARS)}${listing}` };
    },
  });
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (out.length >= MAX_LISTED_FILES) break;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out.slice(0, MAX_LISTED_FILES);
}
