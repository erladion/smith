import type { ToolDef } from "../tool.js";
import { bash } from "./bash.js";
import { editFile, readFile, writeFile } from "./files.js";
import { glob, grep, list } from "./search.js";

export const defaultTools: ToolDef[] = [readFile, list, grep, glob, writeFile, editFile, bash];
