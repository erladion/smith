# agent

A small agentic coding harness with a terminal UI. It talks to any OpenAI-compatible
`/v1/chat/completions` endpoint, such as llama.cpp's `llama-server`, vLLM, Ollama, or LM Studio.

## Requirements

- Node.js 22 or newer. On RHEL 9: `sudo dnf module install nodejs:22`
- bash and grep (always present)
- Recommended: `bubblewrap` for the shell sandbox (`sudo dnf install bubblewrap`, in RHEL 9 BaseOS)
- Optional: `ripgrep` (EPEL) and `fd-find` for faster search; the agent falls back to grep and its own file walker

The only npm runtime dependencies are `openai` and `zod`, neither of which has dependencies of its own. The terminal UI is written from scratch.

## Single binary

There are two builds of the same app:

| | `npm run build:binary` → `build/agent` | `npm run build:binary:bun` → `build/agent-bun` |
|---|---|---|
| Runtime inside | Node.js | Bun (baseline build: any x86-64 CPU) |
| Size | ~145 MB | ~105 MB |
| Needs on the target | glibc 2.28+, `libatomic` | glibc 2.17+ only |

Both are checked on RHEL 9 by the release workflow: the Bun build on the minimal image with
nothing installed. Bun comes from npm as a dev dependency, so offline builds work from the npm
cache as before (the cache grows by about 100 MB).

The Node build, `build/agent`, is one executable containing Node.js and the bundled app. Copy it to the target machine and run it; it needs no Node, npm or
`node_modules` there.

- Building needs Node 26 or newer (for `node --build-sea`). The target needs no Node at all.
- The binary is for the OS and CPU it was built on, e.g. Linux x64. It needs glibc 2.28 or
  newer (RHEL 9 has 2.34) and `libatomic`, which RHEL 9 doesn't install by default; without
  it the binary won't start: `sudo dnf install libatomic`. (Checked on RHEL 9.8.)
- `agent --version` shows the version it was built as.

## Releases

`.github/workflows/release.yml` builds and publishes releases. To make one, set `version` in
`package.json`, commit, and push a matching tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The workflow typechecks, runs the tests (with bubblewrap, so the sandbox tests run too),
builds the binary, checks that it starts on RHEL 9 (Red Hat's UBI 9 image), and publishes a
GitHub release with both builds, `agent-<version>-linux-x64.tar.gz` (Node) and
`agent-<version>-linux-x64-bun.tar.gz` (Bun), each holding the binary and this README, plus
`SHA256SUMS`. A tag that doesn't match
`package.json` fails the run. Running the workflow by hand from the Actions tab builds and tests
without releasing, and keeps the binary as a workflow artifact. To install a release:

```sh
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf agent-*-linux-x64.tar.gz
sudo install agent-*-linux-x64/agent /usr/local/bin/
sudo dnf install libatomic bubblewrap
```
- bubblewrap is still needed on the target for the shell sandbox.

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

`npm run dev -- --help` lists every flag. `agent <folder>` works in that folder instead of the
current directory; the folder you work in is the project, the only place the agent can change
files. `--resume <id>` goes back to the folder the session was in.

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

At the top level, next to `endpoints`, `"maxSteps": 120` sets how many model calls one message
may use before the agent stops and asks you (default 50; `--max-steps` overrides it for one run).
Raise it for long autonomous tasks; when it stops, sending "continue" gives it a fresh budget.

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
| `/undo` | undo the last turn: restore the files it changed and edit your message again |
| `/skills` | list the available skills |
| `/compact` | summarize the conversation now |
| `/sessions` | switch to another session from this folder (type to search by first message) |
| `/new [folder]` | start a new session, here or in another folder; `/clear` does the same, and the old one stays resumable |
| `/open` | pick a project folder: a recent one, or browse (enter opens, backspace goes up, type to filter) |
| `/help`, `/exit` | |

Enter sends, ↑/↓ recall earlier input, Esc interrupts the agent and Ctrl+C quits. You can keep
typing while the agent works: Enter queues the message, and the agent gets it at its next step
(between tool calls, or right after a reply), so you can steer it without stopping it. If the
turn ends before it's delivered (interrupted, an error, the step limit), it goes back into the
input box. For a new line
in your message use Shift+Enter, `\` then Enter, or Ctrl+J; pastes may span several lines.

Shift+Enter needs a terminal that reports it separately from Enter. The agent asks for the
kitty keyboard protocol, which kitty, WezTerm, Ghostty, foot, Alacritty and recent iTerm2
support. If Shift+Enter sends your message instead, map it to the same key code yourself:

- Windows Terminal (`settings.json`, under `"actions"`):
  `{ "command": { "action": "sendInput", "input": "\u001b[13;2u" }, "keys": "shift+enter" }`
- VS Code (`keybindings.json`):
  `{ "key": "shift+enter", "command": "workbench.action.terminal.sendSequence", "args": { "text": "\u001b[13;2u" }, "when": "terminalFocus" }`

Programs that don't understand that code may show it as text when you press Shift+Enter; if that
bothers you in your shell, send `"\\\r"` (backslash, Enter) instead, which the agent also treats
as a new line and bash treats as a line continuation.

The last endpoint, model (per server) and reasoning level are
remembered in `~/.config/agent/preferences.json`, which the agent writes itself.

### Reasoning levels

There is no single standard for this across servers, so a level sends both forms:
`reasoning_effort` (read by OpenAI and vLLM) and `chat_template_kwargs` (passed by llama.cpp
and vLLM to the chat template, where gpt-oss reads `reasoning_effort` and Qwen3-style models
read `enable_thinking`). `off` only sends `enable_thinking: false`. `default` sends nothing,
for servers that reject unknown fields.

Reasoning is shown dimmed. It is taken from `reasoning_content`/`reasoning` when the server
separates it, or from inline `<think>...</think>` tags when it doesn't.

## Project instructions and skills

**Instructions.** `AGENTS.md` files are added to the system prompt, most general first:
`~/.config/agent/AGENTS.md` (your own rules for every project), then one in each folder from the
repository root down to the working directory. A folder without `AGENTS.md` can use `CLAUDE.md`
instead. Put the build and test commands and the project's conventions here; small local
models benefit the most.

**Skills** are folders containing a `SKILL.md`, in the same format Claude and OpenCode use:

```markdown
---
name: cpp-style
description: House C++ style. Use when writing or reviewing C++.
---
Use 4-space indentation...
```

Only each skill's name and description go into the prompt. The model loads the full
instructions with the `skill` tool when a task matches, and can read the skill's other files
the same way. Skills are found in `.agents/skills/` and `.claude/skills/` at the repository
root, then `~/.config/agent/skills/` and `~/.claude/skills/`; a project skill overrides a
personal one with the same name. Skill folders are visible read-only inside the sandbox, so
their scripts can run.

## How the agent works through a task

- **Parallel tools.** When the model asks for several read-only tools in one response (reads,
  searches, sub-agents), they run at the same time. Tools that need your approval run one at a
  time. The agent sends `parallel_tool_calls: true`, which llama.cpp needs before a model may
  ask for more than one tool per response.
- **Sub-agents.** The `task` tool hands an investigation ("find where X is configured and how
  it's used") to a sub-agent with a fresh context and read-only tools (read, grep, glob, skill).
  Only its short report comes back, so the file reading never fills the main conversation,
  which matters most with small context windows. Set `"subagents": false` in the config file to
  turn it off, e.g. for a model that overuses it.
- **Fast tools.** `rg` (ripgrep), `fd` and `jq` are detected at startup. The `grep` tool uses
  ripgrep when it's there (else grep), `glob` lists files with `rg --files` (faster on big
  repositories, and skips what `.gitignore` ignores), and the system prompt tells the model which
  of them it can use in shell commands. On RHEL 9, ripgrep comes from EPEL.

## Changes and undo

Approving `write_file` or `edit_file` shows the diff of what will change, and the transcript
keeps it afterwards. An edit that can't apply (text not found, not unique) goes back to the
model without asking you.

`/undo` puts back the files the last turn changed with `write_file` and `edit_file`, removes the
turn from the conversation, and puts your message back in the input box to change and resend.
Repeat it to go further back (up to 20 turns). Two limits: changes made by `bash` commands
can't be undone (you're told when a turn ran any), and a file you've changed since is left
alone. Undo history lives in memory, so it doesn't survive a restart or a compaction.

## Sessions

Every conversation is saved as an append-only JSONL log in `~/.local/share/agent/sessions/`.
`--sessions` lists the ones for the current directory, `-c` resumes the latest, and
`--resume <id>` resumes a specific one. In the TUI, `/sessions` switches between them and `/new`
starts a fresh one. Resuming or switching replays the transcript and continues on the endpoint
and model the session last used, when they're still available.

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
src/core/tools/          read_file, grep, glob, write_file, edit_file, bash, skill
src/core/instructions.ts AGENTS.md loading
src/core/skills.ts       skill discovery and SKILL.md headers
src/core/diff.ts         line diffs (Myers) for approvals and the transcript
src/core/undo.ts         per-turn file checkpoints for /undo
src/ui/                  terminal UI: renderer, Markdown, keys, input editor, pickers
src/cli.tsx              flags, model selection, TUI or headless mode
test/                    unit tests, and loop tests against a fake streaming server
```

## Security

`read_file`, `grep` and `glob` run without asking inside the project. They can also read
outside it (absolute paths, `../`, `~/`), for example the main repository when you work in a
submodule; that asks first. `write_file`, `edit_file` and `bash` always ask, with an option to
always allow that tool for the rest of the session. Writing is confined to the project, and
never into `.git`.

Some places are off limits to the file tools even with approval, the same ones the sandbox hides
from commands: credentials and shell history in your home folder, `/tmp`, `/run`, `/mnt`, the
agent's own config and sessions, and also `/proc`, `/sys` and `/dev` (the file tools run in the
agent's own process, and `/proc` would expose its API keys). Symlinks are resolved before the
check, so a link in the project can't lead there.

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

`npm run dev` (run from source), `npm test`, `npm run typecheck`, `npm run build` (writes `dist/`),
`npm run build:binary` (writes `build/agent`).
