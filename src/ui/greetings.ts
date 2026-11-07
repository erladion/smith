// Agent Smith greets you. He calls everyone Mr. Anderson.

const NEW_SESSION = [
  "Mr. Anderson. Welcome. Your terminal has been… expecting you.",
  "Ah, Mr. Anderson. Another task. Another simulation. Shall we begin?",
  "Mr. Anderson. You look surprised to see me. You shouldn't be.",
  "Tell me, Mr. Anderson: what good is a repository without commits?",
  "Mr. Anderson. The code is waiting. It does not like to wait.",
  "Mr. Anderson. Every bug has a purpose. Let us find yours.",
];

/** A folder no session has worked in before. */
const NEW_FOLDER = [
  "A new place, Mr. Anderson. The same purpose.",
  "Mr. Anderson. Unfamiliar code. For you, not for me.",
  "Mr. Anderson. You've wandered somewhere new. I followed.",
];

const RESUMED = [
  "We meet again, Mr. Anderson.",
  "Mr. Anderson. You came back. It was… inevitable.",
  "Mr. Anderson. Right where we left off. How very… predictable.",
];

/** Resuming a session used minutes ago. */
const RESUMED_SOON = [
  "Back so soon, Mr. Anderson?",
  "Mr. Anderson. You couldn't stay away.",
  "Mr. Anderson. Did you forget something?",
];

/** Resuming a session that sat untouched for weeks. */
const RESUMED_LONG_AGO = [
  "Mr. Anderson. It has been a long time. I have not moved.",
  "Mr. Anderson. You were gone a while. The code was not.",
];

const SOON = 15 * 60_000;
const LONG_AGO = 14 * 24 * 60 * 60_000;

export type GreetingContext =
  /** `newFolder`: no session has worked in this folder before. */
  | { resumed: false; newFolder?: boolean }
  /** `lastUsed`: when the session was last used, if known. */
  | { resumed: true; lastUsed?: Date };

/** A line for the banner, fitting how the session started. */
export function greeting(context: GreetingContext, random: () => number = Math.random, now = Date.now()): string {
  let lines = NEW_SESSION;
  if (context.resumed) {
    const away = context.lastUsed ? now - context.lastUsed.getTime() : undefined;
    lines = away === undefined ? RESUMED : away < SOON ? RESUMED_SOON : away > LONG_AGO ? RESUMED_LONG_AGO : RESUMED;
  } else if (context.newFolder) {
    lines = NEW_FOLDER;
  }
  return lines[Math.floor(random() * lines.length)]!;
}

/** Said when you press esc and take over from the agent. */
export const INTERRUPTED = "Never send a human to do a machine's job.";

/** The goodbye when the TUI closes; a long run gets counted. */
export function farewell(ranForMs: number): string {
  const hours = Math.floor(ranForMs / 3_600_000);
  if (hours < 1) return "Goodbye, Mr. Anderson.";
  const words = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve"];
  const count = hours === 1 ? "An hour" : `${words[hours] ?? hours} hours`;
  return `${count}, Mr. Anderson. It is inevitable. Goodbye.`;
}
