import type { ToolDef } from "../tool.js";
import { bash } from "./bash.js";
import { editFile, readFile, writeFile } from "./files.js";
import { glob, grep } from "./search.js";

export const defaultTools: ToolDef[] = [readFile, grep, glob, writeFile, editFile, bash];
