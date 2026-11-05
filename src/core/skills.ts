import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configPath } from "./config.js";

/**
 * Skills are folders with a SKILL.md: a short header naming the skill and
 * saying when to use it, then the instructions. Only names and descriptions
 * go into the system prompt; the model loads a skill's instructions (and
 * any files that come with it) on demand with the `skill` tool. This is the
 * same format Claude and OpenCode use, so existing skills work as-is.
 *
 *   ---
 *   name: cpp-style
 *   description: House C++ style. Use when writing or reviewing C++.
 *   ---
 *   Use 4-space indentation...
 */
export interface Skill {
  name: string;
  description: string;
  /** The skill's folder; its other files are relative to this. */
  dir: string;
  /** Instructions: SKILL.md without the header. */
  body: string;
}

const MAX_DESCRIPTION = 1024;

/** Folders searched for skills, highest priority first. */
export function skillRoots(projectRoot: string): string[] {
  return [
    path.join(projectRoot, ".agents", "skills"),
    path.join(projectRoot, ".claude", "skills"),
    path.join(path.dirname(configPath()), "skills"),
    path.join(os.homedir(), ".claude", "skills"),
  ];
}

/** Finds skills under `roots`. A name found earlier wins, so project skills override personal ones. */
export function loadSkills(roots: string[]): { skills: Skill[]; warnings: string[] } {
  const skills = new Map<string, Skill>();
  const warnings: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((x, y) => x.name.localeCompare(y.name))) {
      const dir = path.join(root, entry.name);
      if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(dir))) continue;
      const file = path.join(dir, "SKILL.md");
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const { data, body } = parseFrontmatter(text);
      const name = data.name?.trim() || entry.name;
      const description = data.description?.trim();
      if (!description) {
        warnings.push(`Skill ${file} has no description, so the model couldn't know when to use it; skipped.`);
        continue;
      }
      if (!skills.has(name)) {
        skills.set(name, { name, description: description.slice(0, MAX_DESCRIPTION), dir, body: body.trim() });
      }
    }
  }
  return { skills: [...skills.values()], warnings };
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Reads the `---` header at the top of a Markdown file. Supports the YAML
 * that skill headers use in practice: `key: value`, quoted values, `|` and
 * `>` blocks, and plain values continued on indented lines. Nested
 * structures are skipped.
 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { data: {}, body: text };
  const lines = match[1]!.split(/\r?\n/);
  const data: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!m) continue;
    const [, key, rawValue] = m as unknown as [string, string, string];

    // Indented lines that follow belong to this key.
    const following: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === "")) following.push(lines[++i]!);

    let value: string;
    if (/^[|>][-+]?$/.test(rawValue)) {
      const indent = Math.min(...following.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
      const block = following.map((l) => l.slice(Number.isFinite(indent) ? indent : 0));
      value = rawValue.startsWith("|") ? block.join("\n") : block.join(" ").replace(/\s+/g, " ");
    } else {
      value = [rawValue, ...following.map((l) => l.trim())].filter(Boolean).join(" ");
      const quoted = /^(["'])([\s\S]*)\1$/.exec(value);
      if (quoted) value = quoted[2]!;
    }
    data[key] = value.trim();
  }
  return { data, body: text.slice(match[0].length) };
}
