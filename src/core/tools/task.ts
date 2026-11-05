import { z } from "zod";
import { defineTool, type ToolContext, type ToolDef, type ToolResult } from "../tool.js";

export const taskSchema = z.object({
  description: z.string().min(1).describe("A few words saying what the sub-agent is doing, shown to the user"),
  prompt: z
    .string()
    .min(1)
    .describe("The full task: what to find out, where to look, and what the report should contain. The sub-agent sees nothing else."),
});
export type TaskInput = z.output<typeof taskSchema>;

/**
 * The `task` tool: hands an investigation to a sub-agent with its own,
 * fresh context and read-only tools, and returns only its report. The many
 * file reads stay out of the main conversation, which matters most with
 * small context windows. Sub-agents can't change anything, so several can
 * run at once without asking.
 */
export function createTaskTool(run: (input: TaskInput, ctx: ToolContext) => Promise<ToolResult>): ToolDef {
  return defineTool({
    name: "task",
    description:
      "Delegate a self-contained investigation to a sub-agent that can read files, search and load skills, " +
      "but not change anything. It works in its own context and returns a short report, so use it for searches " +
      "or questions that would take many file reads (e.g. 'find where X is configured and how it is used'). " +
      "Give it everything it needs in prompt: it can't see this conversation. Several task calls in one " +
      "response run in parallel. For one known file, read it yourself instead.",
    schema: taskSchema,
    readOnly: true,
    summarize: ({ description }) => description,
    run,
  });
}
