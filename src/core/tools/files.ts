import { z } from "zod";
import { assertWritable, resolveForRead, resolveInRoot } from "../paths.js";
import { diffLines, diffStats } from "../diff.js";
import { Sandbox } from "../sandbox.js";
import { defineTool, type ToolContext, truncate } from "../tool.js";

const MAX_OUTPUT_CHARS = 20_000;
const DEFAULT_LINE_LIMIT = 500;
const MAX_LINE_CHARS = 1_000;
export const OUTSIDE = "Reads outside the project folder.";

// Reads and writes happen inside the sandbox when it's active, so the file
// tools can reach exactly what shell commands can. The path checks below
// come first, for clear errors; the sandbox enforces them.
const sandboxOf = (ctx: ToolContext) => ctx.sandbox ?? Sandbox.none();
const read = (file: string, ctx: ToolContext) => sandboxOf(ctx).readFile(file, ctx.cwd);

export const readFile = defineTool({
  name: "read_file",
  description:
    "Read a text file. Returns lines prefixed with their 1-based line numbers. " +
    `Reads up to ${DEFAULT_LINE_LIMIT} lines by default; use offset and limit for larger files. ` +
    "Files outside the working directory can be read too (the user is asked first).",
  schema: z.object({
    path: z.string().describe("File path, relative to the working directory, absolute, or starting with ~/"),
    offset: z.number().int().min(1).optional().describe("First line to read (1-based)"),
    limit: z.number().int().min(1).optional().describe("Maximum number of lines to read"),
  }),
  readOnly: true,
  summarize: ({ path: p, offset, limit }) =>
    offset || limit ? `${p} (lines ${offset ?? 1}-${(offset ?? 1) + (limit ?? DEFAULT_LINE_LIMIT) - 1})` : p,
  approvalReason: async ({ path: p }, ctx) => ((await resolveForRead(ctx.cwd, p, ctx.sandbox)).outside ? OUTSIDE : undefined),
  async run({ path: p, offset = 1, limit = DEFAULT_LINE_LIMIT }, ctx) {
    const file = (await resolveForRead(ctx.cwd, p, ctx.sandbox)).path;
    const text = await read(file, ctx);
    if (text.includes("\0")) return { content: `${p} looks like a binary file.`, isError: true };

    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    if (lines.length === 0) return { content: `${p} is empty.` };
    if (offset > lines.length) {
      return { content: `${p} has only ${lines.length} lines.`, isError: true };
    }

    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const body = slice
      .map((line, i) => {
        const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line truncated]` : line;
        return `${offset + i}\t${shown}`;
      })
      .join("\n");
    const end = offset + slice.length - 1;
    const footer = end < lines.length ? `\n\n[Showing lines ${offset}-${end} of ${lines.length}]` : "";
    return { content: truncate(body, MAX_OUTPUT_CHARS) + footer };
  },
});

const writeSchema = z.object({
  path: z.string().describe("File path, relative to the working directory"),
  content: z.string().describe("The full file contents"),
});

/** Works out a write without doing it, so the approval prompt can show the diff. */
async function planWrite({ path: p, content }: z.output<typeof writeSchema>, ctx: ToolContext) {
  const file = await resolveInRoot(ctx.cwd, p);
  assertWritable(ctx.cwd, file);
  const before = await readIfExists(file, ctx);
  return { file, content, created: before === null, diff: diffLines(before ?? "", content) };
}

export const writeFile = defineTool({
  name: "write_file",
  description:
    "Create a file or overwrite it completely. Prefer edit_file for changes to existing files.",
  schema: writeSchema,
  readOnly: false,
  summarize: ({ path: p, content }) => `${p} (${content.split("\n").length} lines)`,
  touches: ({ path: p }) => [p],
  preview: async (input, ctx) => (await planWrite(input, ctx)).diff,
  async run(input, ctx) {
    const plan = await planWrite(input, ctx);
    await ctx.beforeWrite?.(plan.file);
    await sandboxOf(ctx).writeFile(plan.file, plan.content, ctx.cwd);
    ctx.afterWrite?.(plan.file, plan.content);
    const { added, removed } = diffStats(plan.diff);
    const verb = plan.created ? "Created" : "Wrote";
    return { content: `${verb} ${input.path} (+${added} -${removed} lines).`, diff: plan.diff };
  },
});

const editSchema = z.object({
  path: z.string().describe("File path, relative to the working directory"),
  old_string: z.string().min(1).describe("Exact text to replace"),
  new_string: z.string().describe("Replacement text"),
  replace_all: z.boolean().optional().describe("Replace every occurrence instead of exactly one"),
});

/** Works out an edit without doing it. Throws with a message for the model if it can't apply. */
async function planEdit({ path: p, old_string, new_string, replace_all }: z.output<typeof editSchema>, ctx: ToolContext) {
  if (old_string === new_string) throw new Error("old_string and new_string are identical; nothing to change.");
  const file = await resolveInRoot(ctx.cwd, p);
  assertWritable(ctx.cwd, file);
  const text = await read(file, ctx);
  const count = text.split(old_string).length - 1;
  if (count === 0) throw new Error(`old_string was not found in ${p}. Read the file and copy the text exactly.`);
  if (count > 1 && !replace_all) {
    throw new Error(`old_string occurs ${count} times in ${p}. Include more surrounding text to make it unique, or set replace_all.`);
  }
  // split/join and slice avoid String.replace's special `$` patterns.
  const at = text.indexOf(old_string);
  const updated = replace_all
    ? text.split(old_string).join(new_string)
    : text.slice(0, at) + new_string + text.slice(at + old_string.length);
  return { file, updated, replaced: replace_all ? count : 1, diff: diffLines(text, updated) };
}

export const editFile = defineTool({
  name: "edit_file",
  description:
    "Replace an exact string in a file. old_string must match the file exactly, including " +
    "whitespace and indentation, and must occur exactly once unless replace_all is true. " +
    "Read the file first so the match is exact.",
  schema: editSchema,
  readOnly: false,
  summarize: ({ path: p, replace_all }) => (replace_all ? `${p} (all occurrences)` : p),
  touches: ({ path: p }) => [p],
  preview: async (input, ctx) => (await planEdit(input, ctx)).diff,
  async run(input, ctx) {
    let plan: Awaited<ReturnType<typeof planEdit>>;
    try {
      plan = await planEdit(input, ctx);
    } catch (err) {
      return { content: (err as Error).message, isError: true };
    }
    await ctx.beforeWrite?.(plan.file);
    await sandboxOf(ctx).writeFile(plan.file, plan.updated, ctx.cwd);
    ctx.afterWrite?.(plan.file, plan.updated);
    const { added, removed } = diffStats(plan.diff);
    const times = plan.replaced === 1 ? "1 occurrence" : `${plan.replaced} occurrences`;
    return { content: `Replaced ${times} in ${input.path} (+${added} -${removed} lines).`, diff: plan.diff };
  },
});

async function readIfExists(file: string, ctx: ToolContext): Promise<string | null> {
  try {
    return await read(file, ctx);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
