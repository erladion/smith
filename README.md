# agent

A small agentic coding harness with a terminal UI. It talks to any OpenAI-compatible
`/v1/chat/completions` endpoint, such as llama.cpp's `llama-server`, vLLM, Ollama, or LM Studio.

## Requirements

- Node.js 22 or newer. On RHEL 9: `sudo dnf module install nodejs:22`
- bash and grep (always present)
- Recommended: `bubblewrap` for the shell sandbox (`sudo dnf install bubblewrap`, in RHEL 9 BaseOS)
- Optional: `ripgrep` for faster search (EPEL); falls back to grep

npm dependencies are kept to `openai`, `zod`, `ink` and `react`.

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
npm run dev -- -e gpu-box --reasoning high    # a configured endpoint (see below)
npm run dev -- --base-url http://host:8000/v1 --model qwen3-coder   # an ad-hoc server
npm run dev -- -p "list the TODOs in src" --yes   # headless, one prompt
npm run dev -- -c                             # resume the last session in this directory
```

`npm run dev -- --help` lists every flag.

## Endpoints

Servers you use regularly go in `~/.config/agent/config.json`:

```json
{
  "default": "local",
  "endpoints": {
    "local": { "baseURL": "http://localhost:8080/v1" },
    "gpu-box": {
      "baseURL": "http://10.0.0.5:8000/v1",
      "apiKeyEnv": "GPU_BOX_KEY",
      "model": "qwen3-coder-30b",
      "contextSize": 65536
    }
  }
}
```

| Field | |
|---|---|
| `baseURL` | required; the OpenAI-compatible URL, usually ending in `/v1` |
| `apiKeyEnv` | name of an environment variable holding the key (preferred) |
| `apiKey` | the key itself; the file should then be `chmod 600` (you're warned if it isn't) |
| `model` | model to use when you haven't picked one on this endpoint before |
| `contextSize` | context window, for servers that don't report it (e.g. Ollama) |

`--endpoints` lists them, `-e <name>` starts on one, and `/endpoint` switches mid-conversation.
Without `-e`, the agent starts on the resumed session's endpoint, else the one used last, else
`default`. `--base-url` (or `AGENT_BASE_URL`) bypasses the config for a one-off server, and only
then are `AGENT_API_KEY`/`OPENAI_API_KEY` used: keys from your environment are never sent to a
configured endpoint they weren't set for. The file is only read, never written.

## In the TUI

| Command | |
|---|---|
| `/endpoint [name]` | pick a configured endpoint, or switch by name |
| `/model [name]` | pick from the models the server lists, or switch by name |
| `/reasoning [level]` | `default`, `off`, `low`, `medium`, `high` |
| `/network on\|off` | allow or block network access for sandboxed commands |
| `/compact` | summarize the conversation now |
| `/clear` | start over |
| `/help`, `/exit` | |

Esc interrupts the agent. The last endpoint, model (per server) and reasoning level are
remembered in `~/.config/agent/preferences.json`, which the agent writes itself.

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
src/core/config.ts       config file of named endpoints
src/core/server.ts       one server: client, model listing, context-size detection
src/core/reasoning.ts    reasoning levels -> request fields
src/core/think.ts        streaming <think> tag parser
src/core/sandbox.ts      bubblewrap sandbox for shell commands
src/core/glob.ts         glob matching for the glob tool
src/core/tools/          read_file, grep, glob, write_file, edit_file, bash
src/ui/                  Ink (React) TUI, model/reasoning picker, session replay
src/cli.tsx              flags, model selection, TUI or headless mode
test/                    unit tests, and loop tests against a fake streaming server
```

## Security

`read_file`, `grep` and `glob` run without asking. `write_file`, `edit_file` and `bash` ask
first, with an option to always allow that tool for the rest of the session. File tools are
confined to the working directory and may not write into `.git`.

### Shell sandbox

`bash` commands run inside [bubblewrap](https://github.com/containers/bubblewrap) when it is
installed (`--sandbox auto`, the default). Inside the sandbox:

- the filesystem is read-only except the project directory and a private, empty `/tmp`
- credentials and shell history in your home directory (`~/.ssh`, `~/.aws`, `~/.docker`,
  `~/.netrc`, ...) are hidden
- `/run` is hidden, which removes the Docker, Podman and D-Bus sockets (and, on WSL, the
  interop socket that would otherwise let commands start Windows programs)
- the project's `.git` is read-only, because git config and hooks run outside the sandbox the
  next time you use git; the agent can read history but you do the commits
- there is no network unless you pass `--network` or use `/network on`
- only a short allowlist of environment variables is passed in, so tokens don't leak
- other processes are invisible, and everything is killed when the agent exits

`--sandbox on` refuses to start without bubblewrap; `--sandbox off` disables it. The banner,
status line and every approval prompt say whether commands are sandboxed.

What the sandbox can't protect: anything in the project itself (scripts in `package.json`, a
`Makefile`, `.envrc`) can still be changed and will run unsandboxed if you run it yourself
later, and with the network on, commands can reach services on localhost.

## Scripts

`npm run dev` (run from source), `npm test`, `npm run typecheck`, `npm run build` (writes `dist/`).
