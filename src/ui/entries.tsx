import { Box, Text } from "ink";
import type { BlockKind, NoticeLevel } from "../core/events.js";

export type Entry =
  | { id: number; kind: "banner"; model: string; baseURL: string; cwd: string; session: string; resumed: boolean }
  | { id: number; kind: "user"; text: string }
  /** `continued` marks a later chunk of the same streamed block (no top margin). */
  | { id: number; kind: BlockKind; text: string; continued: boolean }
  | { id: number; kind: "tool"; name: string; summary: string; output: string; isError: boolean }
  | { id: number; kind: "notice"; level: NoticeLevel; text: string };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewEntry = DistributiveOmit<Entry, "id">;

const PREVIEW_LINES = 4;
const NOTICE_COLORS: Record<NoticeLevel, string> = { info: "blue", warn: "yellow", error: "red" };

export function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "banner":
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
          <Text bold color="cyan">agent</Text>
          <Text dimColor>model  {entry.model}</Text>
          <Text dimColor>server {entry.baseURL}</Text>
          <Text dimColor>cwd    {entry.cwd}</Text>
          <Text dimColor>
            session {entry.session}
            {entry.resumed && " (resumed)"}
          </Text>
          <Text dimColor>/help for commands · /model and /reasoning to switch · esc interrupts</Text>
        </Box>
      );
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan" bold>{"› "}</Text>
          <Text>{entry.text}</Text>
        </Box>
      );
    case "text":
      return <StreamedText text={entry.text} continued={entry.continued} />;
    case "reasoning":
      return <StreamedText text={entry.text} continued={entry.continued} reasoning />;
    case "tool":
      return <ToolView entry={entry} />;
    case "notice":
      return (
        <Box marginTop={1}>
          <Text color={NOTICE_COLORS[entry.level]}>{entry.text}</Text>
        </Box>
      );
  }
}

export function StreamedText({ text, continued, reasoning }: { text: string; continued: boolean; reasoning?: boolean }) {
  return (
    <Box marginTop={continued ? 0 : 1}>
      {reasoning ? (
        <Text dimColor italic>{text}</Text>
      ) : (
        <Text>{text}</Text>
      )}
    </Box>
  );
}

function ToolView({ entry }: { entry: Extract<Entry, { kind: "tool" }> }) {
  const lines = entry.output.split("\n");
  const preview = lines.slice(0, PREVIEW_LINES).join("\n");
  const hidden = lines.length - PREVIEW_LINES;
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={entry.isError ? "red" : "green"}>● </Text>
        <Text bold>{entry.name}</Text>
        {entry.summary && <Text dimColor> {entry.summary}</Text>}
      </Text>
      <Box paddingLeft={2}>
        <Text dimColor>⎿ </Text>
        <Box flexDirection="column">
          <Text color={entry.isError ? "red" : undefined} dimColor={!entry.isError}>{preview}</Text>
          {hidden > 0 && <Text dimColor>… {hidden} more line{hidden === 1 ? "" : "s"}</Text>}
        </Box>
      </Box>
    </Box>
  );
}
