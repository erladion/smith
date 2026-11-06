// Agent Smith greets you. He calls everyone Mr. Anderson.

const NEW_SESSION = [
  "Mr. Anderson. Welcome. Your terminal has been… expecting you.",
  "Ah, Mr. Anderson. Another task. Another simulation. Shall we begin?",
  "Mr. Anderson. You look surprised to see me. You shouldn't be.",
  "Tell me, Mr. Anderson: what good is a repository without commits?",
  "Mr. Anderson. The code is waiting. It does not like to wait.",
  "Mr. Anderson. Every bug has a purpose. Let us find yours.",
];

const RESUMED = [
  "We meet again, Mr. Anderson.",
  "Mr. Anderson. You came back. It was… inevitable.",
  "Mr. Anderson. Right where we left off. How very… predictable.",
];

export const FAREWELL = "Goodbye, Mr. Anderson.";

/** A line for the banner: a "we meet again" one when continuing a saved session. */
export function greeting(resumed: boolean, random: () => number = Math.random): string {
  const lines = resumed ? RESUMED : NEW_SESSION;
  return lines[Math.floor(random() * lines.length)]!;
}
