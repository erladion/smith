import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** The name the app's own folders go by. */
export const APP = "smith";
/** What it was called before, for moving old folders over. */
const OLD_APP = "agent";

const configBase = () => process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
const dataBase = () => process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");

/** ~/.config/smith: the config file, preferences, personal AGENTS.md and skills. */
export function configDir(): string {
  return path.join(configBase(), APP);
}

/** ~/.local/share/smith: sessions and tool logs. */
export function dataDir(): string {
  return path.join(dataBase(), APP);
}

/**
 * Smith used to be called agent, with its folders at ~/.config/agent and
 * ~/.local/share/agent. Moves them to the new names, once: only when the
 * new folder doesn't exist yet and the old one has what agent kept there.
 * Returns what was done, to tell the user.
 */
export function moveOldFolders(): string[] {
  const notes: string[] = [];
  const moves = [
    { from: path.join(configBase(), OLD_APP), to: configDir(), marks: ["config.json", "preferences.json", "AGENTS.md", "skills"] },
    { from: path.join(dataBase(), OLD_APP), to: dataDir(), marks: ["sessions", "logs"] },
  ];
  for (const { from, to, marks } of moves) {
    if (fs.existsSync(to) || !marks.some((m) => fs.existsSync(path.join(from, m)))) continue;
    try {
      fs.renameSync(from, to);
      notes.push(`Moved ${tildify(from)} to ${tildify(to)}: agent is now called Smith.`);
    } catch (err) {
      notes.push(`Could not move ${tildify(from)} to ${tildify(to)} (${(err as Error).message}); move it yourself to keep its contents.`);
    }
  }
  return notes;
}

function tildify(p: string): string {
  const home = os.homedir();
  return p === home || p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}
