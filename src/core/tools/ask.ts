import { z } from "zod";
import { defineTool, type ToolDef } from "../tool.js";

export interface Question {
  question: string;
  /** Suggested answers; the user can also type their own. */
  options: string[];
}

/** The user's answer: one of the options (by index) or their own words; null if they dismissed it. */
export type Answer = { option: number } | { text: string } | null;

export const ASK_TOOL = "ask_user";

/**
 * The `ask_user` tool: the model asks the user a question, with a few
 * suggested answers, and waits for the reply. `ask` is the frontend's way of
 * asking; without one (a non-interactive run) the tool isn't offered.
 */
export function createAskTool(ask: (q: Question) => Promise<Answer>): ToolDef {
  return defineTool({
    name: ASK_TOOL,
    description:
      "Ask the user a question and wait for the answer. Use it when the request is ambiguous or needs a decision " +
      "only the user can make (which approach, which of several files, missing details), instead of guessing. " +
      "Give 2-4 short options when there are obvious choices; the user can always type their own answer. " +
      "Don't ask about what you can find out by reading the code, and don't ask for permission to run tools: " +
      "the user is asked about those anyway.",
    schema: z.object({
      question: z.string().min(1).describe("The question, ending with a question mark"),
      options: z.array(z.string().min(1)).max(4).optional().describe("Up to 4 suggested answers, a few words each"),
    }),
    readOnly: true,
    summarize: ({ question }) => question,
    async run({ question, options = [] }) {
      const answer = await ask({ question, options });
      if (!answer) return { content: "The user dismissed the question without answering.", isError: true };
      if ("option" in answer) return { content: `The user chose: ${options[answer.option] ?? ""}` };
      return { content: `The user answered: ${answer.text}` };
    },
  });
}
