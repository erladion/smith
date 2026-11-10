# Smith

A small agentic coding harness with a terminal UI. It talks to any OpenAI-compatible
`/v1/chat/completions` endpoint, such as llama.cpp's `llama-server`, vLLM, Ollama, or LM Studio.

Smith used to be called `agent`. On first start it moves `~/.config/agent` and
`~/.local/share/agent` to their new names, so config, sessions and logs carry over, and it still
reads the old `AGENT_BASE_URL`, `AGENT_API_KEY` and `AGENT_MODEL` if the `SMITH_` ones aren't set.

## Requirements

- Node.js 22 or newer. On RHEL 9: `sudo dnf module install nodejs:22`
- bash and grep (always present)
- `bubblewrap` for the shell sandbox, which is required (`sudo dnf install bubblewrap`)
- Optional: `ripgrep` (EPEL) and `fd-find` for faster search; the agent falls back to grep and its own file walker

The only npm runtime dependencies are `openai` and `zod`, neither of which has dependencies of its own. The terminal UI is written from scratch.

## Single binary

There are two builds of the same app:

| | `npm run build:binary` → `build/smith` | `npm run build:binary:bun` → `build/smith-bun` |
|---|---|---|
| Runtime inside | Node.js | Bun (baseline build: any x86-64 CPU) |
| Size | ~145 MB | ~105 MB |
| Needs on the target | glibc 2.28+, `libatomic` | glibc 2.17+ only |

Both are checked on RHEL 9 by the release workflow: the Bun build on the minimal image with
nothing installed. Bun comes from npm as a dev dependency, so offline builds work from the npm
cache as before (the cache grows by about 100 MB).

The Node build, `build/smith`, is one executable containing Node.js and the bundled app. Copy it to the target machine and run it; it needs no Node, npm or
`node_modules` there.

- Building needs Node 26 or newer (for `node --build-sea`). The target needs no Node at all.
- The binary is for the OS and CPU it was built on, e.g. Linux x64. It needs glibc 2.28 or
  newer (RHEL 9 has 2.34) and `libatomic`, which RHEL 9 doesn't install by default; without
  it the binary won't start: `sudo dnf install libatomic`. (Checked on RHEL 9.8.)
- `smith --version` shows the version it was built as.

## Releases

`.github/workflows/release.yml` builds and publishes releases. To make one, set `version` in
`package.json`, commit, and push a matching tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

The workflow typechecks, runs the tests (with bubblewrap, so the sandbox tests run too),
builds the binary, checks that it starts on RHEL 9 (Red Hat's UBI 9 image), and publishes a
GitHub release with both builds, `smith-<version>-linux-x64.tar.gz` (Node) and
`smith-<version>-linux-x64-bun.tar.gz` (Bun), each holding the binary and this README, plus
`SHA256SUMS`. A tag that doesn't match
`package.json` fails the run. Running the workflow by hand from the Actions tab builds and tests
without releasing, and keeps the binary as a workflow artifact. To install a release:

```sh
sha256sum --check --ignore-missing SHA256SUMS
tar -xzf smith-*-linux-x64.tar.gz
sudo install smith-*-linux-x64/smith /usr/local/bin/
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

`npm run dev -- --help` lists every flag. `smith <folder>` works in that folder instead of the
current directory; the folder you work in is the project, the only place the agent can change
files. `--resume <id>` goes back to the folder the session was in.

## Network: HTTPS and proxies

Connections to the model server work like `curl` on the same machine:

- **Certificates.** Besides the runtime's built-in CAs, the agent trusts the system certificate
  store. A server signed by an internal CA works once that CA is in the store (RHEL: copy it to
  `/etc/pki/ca-trust/source/anchors/` and run `sudo update-ca-trust`). `NODE_EXTRA_CA_CERTS=/path/ca.pem`
  adds one without touching the system.
- **Proxies.** `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are used. Running from source on Node 22,
  start it with `node --use-env-proxy --no-warnings dist/cli.js` for that (Node 26 and both
  binaries don't need it).
- **Errors say why.** "Could not reach" is followed by the actual cause (certificate, refused,
  DNS, timeout) and a hint.

## Configuration

Settings live in `~/.config/smith/config.json` (or `$XDG_CONFIG_HOME/smith/config.json`). The
file is optional, only ever read, never written, so hand edits are safe; a mistake in it stops
the agent with a message saying what's wrong. `smith --endpoints` prints an example.

```json
{
  "default": "local",
  "maxSteps": 100,
  "endpoints": {
    "local": { "baseURL": "http://localhost:8080/v1" }
  }
}
```

| Setting | Default | |
|---|---|---|
| `endpoints` | none | the servers you use; see [Endpoints](#endpoints) below |
| `default` | | the endpoint to start on when none was used before |
| `maxSteps` | `50` | model calls one message may use before the agent stops and asks you; sending "continue" gives it a fresh budget. Raise it for long tasks. One call can run several tools; sub-agents get the same limit, each counted separately. `--max-steps <n>` overrides it for one run |
| `subagents` | `true` | `false` takes away the `task` tool, e.g. for a model that overuses it ([more](#how-the-agent-works-through-a-task)) |
| `toolLog` | `true` | `false` turns off the [tool log](#tool-log) |
| `theme` | `"matrix"` | `"plain"` turns off the [Matrix touches](#in-the-tui): rain, katakana spinner, Agent Smith's lines |
| `codeStream` | `true` | with the matrix theme, `false` turns off only the idle stream of glyphs in the status line |
| `sandbox` | bwrap | where commands and the file tools run; see [Sandbox settings](#sandbox-settings) |

Next to it, in the same folder:

| File | |
|---|---|
| `preferences.json` | the endpoint, models and reasoning level you last picked; written by the agent |
| `AGENTS.md` | your own instructions for every project ([more](#project-instructions-and-skills)) |
| `skills/` | your own skills, one folder each with a `SKILL.md` |

Command-line flags win over the file for one run (`smith --help` lists them all), and a few
environment variables are read too: `SMITH_BASE_URL`, `SMITH_API_KEY` and `SMITH_MODEL` (see
below), and `NO_COLOR` to turn off colors (and with them the rain).

### Endpoints

Servers you use regularly go under `endpoints`:

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
`default`. `--base-url` (or `SMITH_BASE_URL`) bypasses the config for a one-off server, and only
then are `SMITH_API_KEY`/`OPENAI_API_KEY` used: keys from your environment are never sent to a
configured endpoint they weren't set for.

### Sandbox settings

```json
{
  "sandbox": {
    "type": "container",
    "network": false,
    "limits": { "memory": "8g", "processes": 4096, "cpus": 4 },
    "home": { "show": ["~/.local/lib"], "writable": ["~/.m2/repository"] },
    "container": {
      "runtime": "podman",
      "image": "registry.access.redhat.com/ubi9/ubi:latest",
      "mounts": ["~/.m2/repository", "~/.gitconfig:ro"]
    },
    "projects": {
      "~/git/webapp": { "image": "localhost/node22-dev:latest" },
      "~/git/backend": { "image": "localhost/java21-dev:latest", "mounts": ["~/.gradle"] }
    }
  }
}
```

| Setting | Default | |
|---|---|---|
| `type` | `"bwrap"` | `"bwrap"` or `"container"` ([which to pick](#shell-sandbox)); `--sandbox bwrap\|container\|off` overrides it for one run, and off can't be set here |
| `network` | `false` | whether commands can use the network from the start; `--network` and `/network` change it |
| `env` | `[]` | more environment variables for commands: `"NAME"` passes yours through, `"NAME=value"` sets one. bwrap already passes the basics, what compilers and build tools read (`CC`, `CFLAGS`, `LD_LIBRARY_PATH`, `PKG_CONFIG_PATH`, `CMAKE_*`, `JAVA_HOME`, `GOFLAGS`, ...), what `gcc-toolset`, `scl` and environment modules set, proxies and CA bundles, but nothing that commonly holds credentials (`NPM_CONFIG_*`, `PIP_INDEX_URL`). A container gets only these and the proxies (when the network is on); the rest comes with its image |
| `limits` | none | caps for each command: `memory` (`"8g"`, `"512m"`; swap counts too), `processes`, `cpus`. With bwrap they need `systemd-run --user`, which RHEL has; without it only `processes` applies, and you're told |
| `home.show` | `[]` | bwrap: home folders shown read-only |
| `home.writable` | `[]` | bwrap: home folders shared read-write (created if missing), e.g. build caches to keep |
| `container.runtime` | `"podman"` | or `"docker"` |
| `container.image` | `ubi9/ubi` | the image when no `projects` entry matches |
| `container.mounts` | `[]` | `"path"`, `"path:ro"`, `"path:/inside"` or `"path:/inside:ro"`; the same path inside when not given |
| `projects` | `{}` | per folder: its own `image` and extra `mounts`; the most specific folder containing the project wins |

## In the TUI

The default `matrix` theme adds some Agent Smith:

- a second of digital rain at startup that settles into "AGENT SMITH" (any key skips it)
- a green katakana spinner, and a strip of rain while the conversation is being compacted
- a slow stream of glyphs at the right end of the status line while the agent is idle
  (`"codeStream": false` turns off just that; some terminals jump to the bottom on any output)
- greetings that notice where you are: a new folder, a session resumed minutes later or after
  weeks; a remark when you interrupt with esc; a farewell that counts long runs
- and a command `/help` doesn't list. Take the red pill.

`"theme": "plain"` in the config file turns all of it off. Animations are left out when colors are
off (`NO_COLOR`) or the window is very small. The glyphs are half-width katakana, which terminals
show with a fallback font if theirs lacks them.

Type `/` and the commands appear under the input; each letter narrows the list (`/h` leaves
`/help`). ↑/↓ pick one, Tab completes it, Enter runs it, Esc hides the list. After a command and a
space, its argument completes too: reasoning levels, `on`/`off`, `all`, endpoint and model names,
and folders for `/new`.

| Command | |
|---|---|
| `/endpoint [name]` | pick a configured endpoint, or switch by name |
| `/model [name]` | pick from the models the server lists, or switch by name |
| `/reasoning [level]` | `default`, `off`, `low`, `medium`, `high` |
| `/network on\|off` | allow or block network access for sandboxed commands |
| `/undo` | undo the last turn: restore the files it changed and edit your message again |
| `/skills` | list the available skills |
| `/compact` | summarize the conversation now |
| `/sessions [all]` | switch to another session from this folder, or from every folder with `all` (type to search by name) |
| `/name [name]` | show or set the current session's name |
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
remembered in `~/.config/smith/preferences.json`, which the agent writes itself.

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
`~/.config/smith/AGENTS.md` (your own rules for every project), then one in each folder from the
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
root, then `~/.config/smith/skills/` and `~/.claude/skills/`; a project skill overrides a
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
- **A todo list.** For a task with several steps, the model writes a checklist with
  `todo_write` and rewrites it as steps start and finish. The transcript shows the list each time
  it changes, and the step in progress shows under the spinner. If the model stops while steps
  are left, it's reminded of them once per turn, since small models often stop halfway. The list
  is part of the conversation, so it comes back with a resumed session and is kept when the
  conversation is compacted.
- **Questions.** When a request is unclear, the model can ask with `ask_user`, suggesting up to
  four answers. Pick one with ↑/↓ and enter or its number, or type your own answer; esc
  dismisses the question and interrupts. With `-p` nobody can answer, so the tool isn't offered
  and the model is told to state its assumptions instead.
- **It knows where it runs.** The system prompt says what the sandbox allows (what's writable,
  what's visible, the network, whether it can install packages), and how to approach a build: find
  the project's own build command first, give long builds a bigger timeout, start from the first
  error. When a command fails because of the sandbox (a read-only path, no network, a file in the
  hidden part of home), the result says so, so the model doesn't "fix" code that was fine.
- **Long output keeps its errors.** Command output over 20,000 characters is cut, keeping the
  start, the end, and the lines in between that look like errors (with the two lines after each,
  where compilers show the code).
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

Every conversation is saved as an append-only JSONL log in `~/.local/share/smith/sessions/`.
Session files are readable by you only (600, folders 700); files from older versions are
tightened the next time the agent starts.

Each session has a name: the first line of your first message, until you give it one with
`/name`. Naming a session saves it right away, even before its first message.

```sh
smith --sessions                 # every session from every folder: name, folder, last used, size, model, id
smith ~/git/webapp --sessions    # only that folder's
smith --resume login-fix         # by name or id, from anywhere: it goes back to the session's folder
smith -c                         # the latest session in the current folder
```

In the TUI, `/sessions` switches between this folder's sessions, `/sessions all` between every
folder's (moving to that folder), and `/new` starts a fresh one. Resuming or switching replays
the transcript and continues on the endpoint and model the session last used, when they're still
available.

## Tool log

Every tool call is also logged, one JSON object per line, to
`~/.local/share/smith/logs/<session id>.jsonl` (readable by you only, like sessions). A line
says when the call started, which session and folder it ran in, the tool and its arguments,
how approval went, how it ended and how long it took, and its output (cut at 10,000
characters; the session keeps all of it). Calls made by sub-agents carry `"subagent"`.

```json
{"time":"2026-11-06T12:56:14.043Z","session":"20261106-125613-704d","cwd":"/home/me/git/webapp",
 "tool":"bash","input":{"command":"npm test"},"approval":"allowed","status":"ok","durationMs":2140,"output":"..."}
```

| Field | Values |
|---|---|
| `approval` | `not needed` (read-only, inside the project), `allowed`, `allowed always`, `already allowed` (always-allowed earlier in the session), `denied`; missing when the call failed before that point |
| `status` | `ok`, `error` (the tool failed), `denied` (you said no), `invalid` (unknown tool or bad arguments) |

Compaction doesn't touch the log, so it keeps everything the agent did. Nothing deletes old
logs; remove them when you like. For example, every shell command the agent ran:

```sh
jq -c 'select(.tool == "bash") | [.time, .input.command, .status]' ~/.local/share/smith/logs/*.jsonl
```

Set `"toolLog": false` in the config file to turn it off.

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
src/core/toollog.ts      the per-session log of tool calls
src/core/config.ts       config file of named endpoints
src/core/server.ts       one server: client, model listing, context-size detection
src/core/reasoning.ts    reasoning levels -> request fields
src/core/think.ts        streaming <think> tag parser
src/core/sandbox.ts      bubblewrap sandbox for shell commands
src/core/glob.ts         glob matching for the glob tool
src/core/tools/          read_file, list_files, grep, glob, write_file, edit_file, bash, skill, task,
                         todo_write, ask_user
src/core/instructions.ts AGENTS.md loading
src/core/skills.ts       skill discovery and SKILL.md headers
src/core/diff.ts         line diffs (Myers) for approvals and the transcript
src/core/undo.ts         per-turn file checkpoints for /undo
src/tui/                 general terminal toolkit: renderer, keys, input editor, Markdown,
                         pickers, digital rain; it doesn't import the agent (a test keeps it that way)
src/ui/app.ts            the agent's TUI: screen, keys, agent turns, slash commands
src/ui/sessions.ts       /new, /sessions, /name, /open and the folder browser
src/ui/connection.ts     /endpoint, /model, /reasoning
src/ui/                  also: transcript entries, command list and suggestions, replay
src/cli.ts               flags, model selection, TUI or headless mode
test/                    unit tests, and loop tests against a fake streaming server
```

## Security

`read_file`, `list_files`, `grep` and `glob` run without asking inside the project. They can
also read outside it (absolute paths, `../`, `~/`), for example the main repository when you
work in a submodule; that asks first. `write_file`, `edit_file` and `bash` always ask, with an option to
always allow that tool for the rest of the session. Writing is confined to the project, and
never into `.git`.

The file tools read and write inside the same sandbox as `bash` (below), so they can reach
exactly what commands can, and `grep`, `glob` and `list_files` run their searches and listings
in it too.
Before that, the agent checks the path itself, to give clear errors: some places are off limits
even with approval, the same ones the sandbox hides from commands (credentials and shell history
in your home folder, `/tmp`, `/run`, `/mnt`, the agent's own config and sessions), and also
`/proc`, `/sys` and `/dev`. Symlinks are resolved before the check, so a link in the project
can't lead there. With `--sandbox off`, only these checks apply. Since the reads happen in the
sandbox, a read outside the project finds only what the sandbox shows: with bwrap, most of your
home folder isn't there; in a container, it's the container's own files.

With the sandbox, `/tmp` and `/var/tmp` are the session's private ones (below), so the read-only
tools read them without asking: a build log a command left there is one read away. A symlink in
there that leads elsewhere counts as a read outside the project, and asks.

### Shell sandbox

`bash` commands, and the file tools' reads and writes, run in a sandbox, and it's required: if
it can't run, the agent doesn't start. There are two kinds: bubblewrap (the default, below) and
[containers](#container-sandbox). Commands time out after 5 minutes unless the model asks for
longer (up to 10).

With [bubblewrap](https://github.com/containers/bubblewrap):

- the filesystem is read-only except the project directory and a private `/tmp` and
  `/var/tmp`: empty at first, kept between commands for as long as the agent runs (so a build
  can leave files there for the next command), and deleted when it exits
- your home folder is replaced by a private, empty one, kept the same way: builds can write
  caches to `~/.cache` and the like, but other projects, tokens and dotfiles aren't there.
  Shown read-only on top of it: the project, the repository it's in (for a submodule or
  subfolder), skill folders, and the folders on your `PATH` inside home, so your own tools keep
  working (for a `bin` folder its parent, e.g. `~/.cargo`, except `~/bin` and `~/.local/bin`).
  `sandbox.home.show` adds more, and `sandbox.home.writable` shares folders read-write, for
  caches you want to keep, like `~/.m2/repository`
- credentials and shell history in your home directory (`~/.ssh`, `~/.aws`, `~/.docker`,
  `~/.netrc`, ...) stay hidden even if a shown folder contains them
- `/run` is hidden, which removes the Docker, Podman and D-Bus sockets (and, on WSL, the
  interop socket that would otherwise let commands start Windows programs)
- the project's `.git` is read-only, because git config and hooks run outside the sandbox the
  next time you use git; the agent can read history but you do the commits
- there is no network unless you pass `--network` or use `/network on`
- only a short allowlist of environment variables is passed in, so tokens don't leak
- other processes are invisible, and everything is killed when the agent exits

### Container sandbox

With `"sandbox": { "type": "container" }` (or `--sandbox container` for one run), commands run
in a podman (or docker) container instead, one per project for the session, removed when Smith
exits:

- **What's in it.** The image (`ubi9/ubi` by default, or per project; see
  [Sandbox settings](#sandbox-settings)), plus the project mounted read-write at the same path,
  so paths in commands and their output are the same inside and out. Its `.git` is mounted
  read-only. Nothing else from your machine is there except the `mounts` you list, and skill
  folders (read-only).
- **Root, safely.** Commands run as root in the container, so they can `dnf install` or
  `pip install` what a build needs, without touching your machine. With rootless podman (the
  normal case on RHEL) that root is your own user outside, so files it makes in the project are
  yours. With docker running as root, commands run as your user instead and can't install
  system packages; you're told at startup.
- **Kept for the session.** Each command runs in the same container (`exec`, about 0.1 s), so
  `/tmp` and anything installed stay until Smith exits. A timeout or esc kills the command and
  everything it started inside the container.
- **The file tools.** Inside the project they work on your disk directly (it's the same
  folder); anything else, like `read_file /usr/include/stdio.h`, comes from the container,
  without asking, since nothing of yours is there. Searches in the project run outside, where
  ripgrep is.
- **Network.** None (`--network none`) unless turned on. A running container can't change
  that, so `/network on` replaces it with a new one, without what was installed. Start with
  `--network` when the agent will need to download things.
- **SELinux.** On RHEL, the project and mounts are relabelled for containers once (`:z`),
  which keeps SELinux's protection. For your home folder or `/` that would upset everything
  else, so then SELinux separation is turned off for that container instead.

The image needs `bash`; `grep`, `find` and `cat` let the file tools reach outside the project.
The first command waits while the image is pulled, if it isn't on the machine yet.

`--sandbox off` runs commands without any sandbox. That has to be asked for on every run, and is
meant for places neither can work, such as inside a container that already isolates the agent.
The banner, status line and every approval prompt say where commands run.

What neither sandbox can protect: anything in the project itself (scripts in `package.json`, a
`Makefile`, `.envrc`) can still be changed and will run unsandboxed if you run it yourself
later, and with the network on, commands can reach services on localhost.

## Scripts

`npm run dev` (run from source), `npm test`, `npm run typecheck`, `npm run build` (writes `dist/`),
`npm run build:binary` (writes `build/smith`).
