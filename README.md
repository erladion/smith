# agent

A small agentic coding harness with a terminal UI. It talks to any OpenAI-compatible
`/v1/chat/completions` endpoint, such as llama.cpp's `llama-server`, vLLM, Ollama, or LM Studio.

## Running against llama.cpp

Start `llama-server` with `--jinja` (required for tool calling) and a context window large
enough for tool output:

```sh
llama-server -m your-model.gguf --jinja -c 32768
```

Then, from the directory you want the agent to work in:

```sh
npm install
npm run dev                                   # TUI
npm run dev -- --base-url http://host:8000/v1 --model qwen3-coder --reasoning high
npm run dev -- -p "list the TODOs in src" --yes   # headless, one prompt
npm run dev -- -c                             # resume the last session in this directory
```

Settings can also come from `AGENT_BASE_URL`, `AGENT_MODEL` and `AGENT_API_KEY`.
`npm run dev -- --help` lists every flag.

## In the TUI

| Command | |
|---|---|
| `/model [name]` | pick from the models the server lists, or switch by name |
| `/reasoning [level]` | `default`, `off`, `low`, `medium`, `high` |
| `/compact` | summarize the conversation now |
| `/clear` | start over |
| `/help`, `/exit` | |

Esc interrupts the agent. The last model (per server) and reasoning level are remembered in
`~/.config/agent/preferences.json`.

### Reasoning levels

There is no single standard for this across servers, so a level sends both forms:
`reasoning_effort` (read by OpenAI and vLLM) and `chat_template_kwargs` (passed by llama.cpp
and vLLM to the chat template, where gpt-oss reads `reasoning_effort` and Qwen3-style models
read `enable_thinking`). `off` only sends `enable_thinking: false`. `default` sends nothing,
for servers that reject unknown fields.

Reasoning is shown dimmed. It is taken from `reasoning_content`/`reasoning` when the server
separates it, or from inline `<think>...</think>` tags when it doesn't.

## Sessions

Every conversation is saved as an append-only JSONL log in `~/.local/share/agent/sessions/`.
`--sessions` lists the ones for the current directory, `-c` resumes the latest, and
`--resume <id>` resumes a specific one. Resuming replays the transcript and continues with
the model the session last used.

## Context management

The context window is read from llama.cpp's `/props` or vLLM's model listing, or set with
`--context-size`. When the conversation reaches 75% of it, the agent first clears old tool
outputs (keeping the 3 most recent); if that isn't enough, it asks the model to summarize
everything except the latest messages. If the server still rejects a request as too long,
the agent compacts once and retries, learning the window size from llama.cpp's error.

## Layout

```
src/core/agent.ts        the loop: stream, run tools, feed results back; compaction
src/core/context.ts      token estimates, trimming, summary prompt, overflow detection
src/core/session.ts      JSONL session logs
src/core/server.ts       model listing and context-size detection
src/core/reasoning.ts    reasoning levels -> request fields
src/core/think.ts        streaming <think> tag parser
src/core/tools/          read_file, grep, glob, write_file, edit_file, bash
src/ui/                  Ink (React) TUI, model/reasoning picker, session replay
src/cli.tsx              flags, model selection, TUI or headless mode
test/                    unit tests, and loop tests against a fake streaming server
```

`read_file`, `grep` and `glob` run without asking. `write_file`, `edit_file` and `bash` ask
first, with an option to always allow that tool for the rest of the session. File tools are
confined to the working directory; `bash` is not, so the approval prompt is what guards it.

## Scripts

`npm run dev` (run from source), `npm test`, `npm run typecheck`, `npm run build` (writes `dist/`).
