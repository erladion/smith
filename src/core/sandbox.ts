import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContainerSandbox } from "./container.js";

/**
 * Runs shell commands, and the file tools' reads and writes, inside
 * bubblewrap (bwrap), the same unprivileged sandbox Flatpak uses. Inside the
 * sandbox:
 *
 * - The whole filesystem is read-only, except the project directory and a
 *   private /tmp (and /var/tmp). That /tmp starts empty and is kept for as
 *   long as the agent runs, so one command can use what another left there;
 *   it's deleted when the agent exits.
 * - The home folder is a private, empty one too, showing only the project,
 *   the tool folders on PATH and the folders chosen in the config.
 *   Credentials and history in it (~/.ssh, ~/.aws, shell history, ...) stay
 *   hidden even then, as are /run (Docker, Podman and D-Bus sockets)
 *   and /mnt (Windows drives and the WSL interop socket on WSL).
 * - The project's .git directory is read-only, because git config and hooks
 *   run later, outside the sandbox, the next time you use git.
 * - There is no network unless enabled, and no other processes are visible.
 * - Only a short allowlist of environment variables is passed in, so API
 *   keys and tokens in your environment don't leak.
 * - Everything is killed when the agent exits.
 *
 * Only flags available in bubblewrap 0.4 are used, the version RHEL 9 ships.
 */

/**
 * Environment variables passed into the bwrap sandbox: the basics, and what
 * compilers and build tools read (including what RHEL's gcc-toolset, scl and
 * environment modules set). Left out: anything that commonly holds
 * credentials, such as NPM_CONFIG_* or PIP_INDEX_URL; sandbox.env adds more.
 */
const ENV_ALLOW = new RegExp(
  "^(" +
    [
      "PATH|HOME|USER|LOGNAME|SHELL|TERM|TZ|LANG|LANGUAGE|LC_[A-Z_]+|COLORTERM|NO_COLOR|FORCE_COLOR|CI|EDITOR",
      // Compilers and linkers.
      "CC|CXX|CPP|FC|F77|LD|AR|AS|NM|RANLIB|STRIP|CFLAGS|CXXFLAGS|CPPFLAGS|FFLAGS|LDFLAGS|LDLIBS|MAKEFLAGS|CMAKE_[A-Z_]+",
      "LD_LIBRARY_PATH|LIBRARY_PATH|CPATH|C_INCLUDE_PATH|CPLUS_INCLUDE_PATH|PKG_CONFIG_PATH|PKG_CONFIG_LIBDIR|MANPATH|INFOPATH",
      // gcc-toolset / scl, and environment modules.
      "X_SCLS|PCP_DIR|MODULEPATH|MODULESHOME|LOADEDMODULES|_LMFILES_|MODULES_[A-Z_]+|LMOD_[A-Z_]+",
      // Languages and their build tools.
      "JAVA_HOME|MAVEN_HOME|M2_HOME|MAVEN_OPTS|GRADLE_HOME|GRADLE_USER_HOME|GRADLE_OPTS|JAVA_TOOL_OPTIONS",
      "GOPATH|GOROOT|GOFLAGS|GOCACHE|GOMODCACHE|GOPROXY|GOPRIVATE|GONOSUMDB|GOTOOLCHAIN|CGO_ENABLED",
      "CARGO_HOME|RUSTUP_HOME|RUSTFLAGS|CARGO_TARGET_DIR",
      "VIRTUAL_ENV|CONDA_PREFIX|CONDA_DEFAULT_ENV|PYTHONPATH|PYTHONHOME|NODE_PATH|NODE_OPTIONS|GEM_HOME|GEM_PATH|PERL5LIB",
      // Proxies and internal certificate authorities, for when the network is on.
      "HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|http_proxy|https_proxy|no_proxy|all_proxy",
      "SSL_CERT_FILE|SSL_CERT_DIR|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|NODE_EXTRA_CA_CERTS",
    ].join("|") +
    ")$",
);

/** The proxy variables, which a container needs from here too (its own build settings come with its image). */
export const PROXY_VARS = /^(HTTP_PROXY|HTTPS_PROXY|NO_PROXY|ALL_PROXY|http_proxy|https_proxy|no_proxy|all_proxy)$/;

/**
 * The variables for sandboxed commands: those of `allowed` from this
 * environment, then `extra` from the config: "NAME" passes NAME through,
 * "NAME=value" sets it.
 */
export function sandboxEnv(allowed: RegExp, extra: string[] = []): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined && allowed.test(name)) env[name] = value;
  for (const entry of extra) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    else if (process.env[entry] !== undefined) env[entry] = process.env[entry]!;
  }
  for (const name of AGENT_SECRETS) delete env[name];
  return env;
}


/** Variables holding this agent's own credentials, removed even when unsandboxed. */
const AGENT_SECRETS = ["SMITH_API_KEY", "AGENT_API_KEY", "OPENAI_API_KEY"];

/** Replaced by empty directories. /tmp and /var/tmp become private scratch space (see TEMP_DIRS). */
const HIDDEN_SYSTEM_DIRS = ["/tmp", "/var/tmp", "/run", "/mnt", "/media"];

/** The temp directories, and the folder under the agent's private temp folder that stands in for each. */
const TEMP_DIRS: Record<string, string> = { "/tmp": "tmp", "/var/tmp": "var-tmp" };

/** Relative to the home directory. */
const HIDDEN_HOME_PATHS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".kube",
  ".docker",
  ".config/containers",
  ".netrc",
  ".git-credentials",
  ".password-store",
  ".local/share/keyrings",
  ".config/gh",
  ".npmrc",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".mozilla",
  ".config/google-chrome",
  ".config/chromium",
  ".bash_history",
  ".zsh_history",
  ".python_history",
  ".local/share/fish/fish_history",
  ".claude",
  ".claude.json",
  // Smith's own sessions and settings (and where they were before the rename).
  ".config/smith",
  ".local/share/smith",
  ".config/agent",
  ".local/share/agent",
];

// The file tools run in the agent's own process, not in the sandbox, so they
// also need these hidden: /proc holds every process's environment, including
// the agent's API keys.
const HIDDEN_FROM_FILE_TOOLS = ["/proc", "/sys", "/dev"];

/**
 * Whether a path is off limits to the agent's file tools: the same places
 * the sandbox hides from commands (credentials, sockets, other temp files,
 * the agent's own data) plus /proc, /sys and /dev.
 */
export function isHiddenFromAgent(file: string): boolean {
  const home = os.homedir();
  const roots = [...HIDDEN_SYSTEM_DIRS, ...HIDDEN_FROM_FILE_TOOLS, ...HIDDEN_HOME_PATHS.map((rel) => path.join(home, rel))];
  return roots.some((root) => file === root || file.startsWith(root + path.sep));
}

export interface SpawnSpec {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Where to start it on this machine, when that matters (unsandboxed); a sandbox changes folder itself. */
  cwd?: string;
  /** Stops the command where killing `file`'s process group isn't enough (inside a container). */
  kill?: () => void;
}

export type SandboxType = "bwrap" | "container" | "off";

/** Caps for each shell command; unset means no cap. */
export interface Limits {
  /** Bytes of memory. */
  memory?: number;
  processes?: number;
  cpus?: number;
}

export interface ContainerSettings {
  runtime: "podman" | "docker";
  /** The image when no `projects` entry matches. */
  image: string;
  /** Host folders or files to mount, as in the config: "src", "src:ro", "src:dst", "src:dst:ro" (~ expanded). */
  mounts: string[];
  /** Per-folder image and extra mounts; the most specific folder containing the project wins. */
  projects: { folder: string; image?: string; mounts: string[] }[];
}

export interface SandboxOptions {
  type: SandboxType;
  network: boolean;
  /** More variables for commands: "NAME" passes it through, "NAME=value" sets it. */
  env?: string[];
  limits?: Limits;
  /** bwrap: home folders shown read-only, and ones kept writable (absolute paths). */
  home?: { show: string[]; writable: string[] };
  container?: ContainerSettings;
}

/**
 * Where shell commands run, and where the file tools read and write: in
 * bubblewrap, in a container, or (when asked for) directly.
 */
export interface Sandbox {
  readonly type: SandboxType;
  /** Whether commands are isolated at all. */
  readonly active: boolean;
  /** Why it isn't active, when it isn't. */
  readonly reason?: string;
  /** Whether commands can use the network. Can be changed at runtime. */
  network: boolean;
  /** Extra folders made visible read-only: skill folders, the repository a submodule is in. */
  readOnlyPaths: string[];
  /** Problems with the settings worth telling the user about at startup. */
  readonly warnings: string[];
  /** One line for the banner and approval prompts. */
  describe(project?: string): string;
  /** How to run `command` with bash in `cwd` (the project). */
  spawnSpec(command: string, cwd: string): Promise<SpawnSpec>;
  /**
   * How to run a program directly (no shell). `project` is the writable
   * folder; it starts in `chdir` (default: the project). No network.
   */
  programSpec(file: string, args: string[], project: string, opts?: { chdir?: string }): Promise<SpawnSpec>;
  /** Reads a file as commands see it. Errors carry `code` (ENOENT, EISDIR, ...) like fs errors. */
  readFile(file: string, project: string): Promise<string>;
  /** Writes a file, creating its folder; only where commands could write it. */
  writeFile(file: string, content: string, project: string): Promise<void>;
  /**
   * For a path outside the project that belongs to the sandbox itself (its
   * private /tmp, a container's own files): where it really is on this
   * machine (`host`, inside `root`), or {} if it has no place here at all.
   * Undefined for ordinary paths.
   */
  sandboxPath(p: string, project: string): { host?: string; root?: string } | undefined;
  /** What the model should know about where its commands run, for the system prompt. */
  promptNotes(project: string): string[];
  /** A note for the model when a failed command's output looks like the sandbox's doing, else undefined. */
  explainFailure(output: string, project: string): string | undefined;
  /** Stops and removes what it started (containers); also done at exit. */
  dispose(): void;
}

const READ_ONLY = /Read-only file system|EROFS/;
const NO_NETWORK =
  /Could not resolve host|Temporary failure in name resolution|Name or service not known|getaddrinfo (ENOTFOUND|EAI_AGAIN)|Network is unreachable|ENETUNREACH|Failed to establish a new connection|Could not resolve|no such host|Cannot download|Connection refused.*:443|Failed to connect to/i;

/** The note for a network failure while the network is off. */
function networkNote(output: string, network: boolean): string | undefined {
  if (network || !NO_NETWORK.test(output)) return undefined;
  return "[Sandbox: the network is off, so this couldn't download or connect. Don't work around it; tell the user they can turn it on with /network on, or carry on without it.]";
}

export const Sandbox = {
  /** No sandbox: commands run directly with bash (still without Smith's API keys). */
  none(reason = "sandbox disabled"): Sandbox {
    return new NoSandbox(reason);
  },

  /**
   * bwrap (the default) requires bubblewrap: if it can't run, Smith doesn't
   * start. "container" needs podman or docker. "off" never sandboxes; it has
   * to be asked for explicitly.
   */
  create(opts: SandboxOptions): Sandbox {
    if (opts.type === "off") return new NoSandbox("disabled with --sandbox off");
    if (opts.type === "container") {
      if (!opts.container) throw new Error("Container settings are missing.");
      return new ContainerSandbox(opts.container, opts.network, opts.limits, opts.env);
    }
    const problem = probeBwrap();
    if (problem) {
      throw new Error(
        `Shell commands run in a sandbox, but bubblewrap can't run: ${problem}\n` +
          "On RHEL/Fedora: sudo dnf install bubblewrap\n" +
          "To run without a sandbox anyway (e.g. inside a container that already isolates it), pass --sandbox off.",
      );
    }
    return new BwrapSandbox(opts.network, opts.limits, opts.home, opts.env);
  },
};

/** The environment for a program run outside any sandbox: everything but Smith's own keys. */
export function hostEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of AGENT_SECRETS) delete env[name];
  return env;
}

class NoSandbox implements Sandbox {
  readonly type = "off";
  readonly active = false;
  network = true;
  readOnlyPaths: string[] = [];
  readonly warnings: string[] = [];

  constructor(readonly reason: string) {}

  describe(): string {
    return `not sandboxed (${this.reason})`;
  }

  async spawnSpec(command: string): Promise<SpawnSpec> {
    return { file: "bash", args: ["-c", command], env: hostEnv() };
  }

  async programSpec(file: string, args: string[], project: string, opts: { chdir?: string } = {}): Promise<SpawnSpec> {
    return { file, args, env: hostEnv(), cwd: opts.chdir ?? project };
  }

  readFile(file: string): Promise<string> {
    return fs.promises.readFile(file, "utf8");
  }

  async writeFile(file: string, content: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, content, "utf8");
  }

  sandboxPath(): undefined {
    return undefined;
  }

  promptNotes(): string[] {
    return ["Shell commands run directly on the user's machine, not in a sandbox. Be careful with anything that changes things outside the working directory."];
  }

  explainFailure(): undefined {
    return undefined;
  }

  dispose(): void {}
}

class BwrapSandbox implements Sandbox {
  readonly type = "bwrap";
  readonly active = true;
  readOnlyPaths: string[] = [];
  readonly warnings: string[] = [];
  /** The host folder holding the private /tmp, /var/tmp and home, made on first use. */
  private tempRoot: string | undefined;
  /** Home folders shown read-only (yours, plus tool folders on PATH) and kept writable. */
  private readonly home: { show: string[]; writable: string[] };
  /** What runs each command under to apply the limits, if any. */
  private readonly limiter: string[];

  constructor(
    public network: boolean,
    limits: Limits | undefined,
    home: { show: string[]; writable: string[] } = { show: [], writable: [] },
    private readonly extraEnv: string[] = [],
  ) {
    this.home = { show: [...pathFoldersInHome(), ...home.show], writable: home.writable };
    for (const dir of home.writable) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        this.warnings.push(`Can't create ${dir} for sandbox.home.writable: ${(err as Error).message}`);
      }
    }
    for (const dir of home.show) if (!fs.existsSync(dir)) this.warnings.push(`${dir} (sandbox.home.show) doesn't exist; it's skipped.`);
    this.limiter = limiterFor(limits, this.warnings);
  }

  describe(): string {
    return `sandboxed: writes limited to the project, home folder hidden, network ${this.network ? "on" : "off"}`;
  }

  async spawnSpec(command: string, cwd: string): Promise<SpawnSpec> {
    const spec = this.bwrap("bash", ["-c", command], cwd, { network: this.network });
    if (this.limiter.length === 0) return spec;
    // systemd-run finds your user's systemd through these; env -u in the limiter removes them again.
    const { XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS } = process.env;
    const env = { ...spec.env, ...(XDG_RUNTIME_DIR && { XDG_RUNTIME_DIR }), ...(DBUS_SESSION_BUS_ADDRESS && { DBUS_SESSION_BUS_ADDRESS }) };
    return { ...spec, env, file: this.limiter[0]!, args: [...this.limiter.slice(1), spec.file, ...spec.args] };
  }

  async programSpec(file: string, args: string[], project: string, opts: { chdir?: string } = {}): Promise<SpawnSpec> {
    return this.bwrap(file, args, project, { chdir: opts.chdir, network: false });
  }

  private bwrap(file: string, args: string[], project: string, opts: { chdir?: string; network: boolean }): SpawnSpec {
    const env: NodeJS.ProcessEnv = { ...sandboxEnv(ENV_ALLOW, this.extraEnv), TMPDIR: "/tmp" };
    const root = this.privateTemp();
    const sandboxArgs = bwrapArgs(project, {
      network: opts.network,
      readOnlyPaths: this.readOnlyPaths,
      tempRoot: root,
      home: { private: path.join(root, "home"), ...this.home },
      chdir: opts.chdir,
    });
    return { file: "bwrap", args: [...sandboxArgs, "--", file, ...args], env };
  }

  async readFile(file: string, project: string): Promise<string> {
    const { code, stdout, stderr } = await run(await this.programSpec("cat", ["--", file], project));
    if (code === 0) return stdout.toString("utf8");
    const err = fileError(stderr, file, "open");
    if (err.code === "ENOENT" && this.hiddenHomePath(file, project)) {
      err.message += ` (the home folder is hidden in the sandbox, apart from the project and the folders in sandbox.home.show)`;
    }
    throw err;
  }

  async writeFile(file: string, content: string, project: string): Promise<void> {
    const script = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';
    const { code, stderr } = await run(await this.programSpec("bash", ["-c", script, "bash", file], project), content);
    if (code !== 0) throw fileError(stderr, file, "write");
  }

  /** /tmp and /var/tmp are this run's own (unless the path is the project or another folder mounted on top). */
  sandboxPath(p: string, project: string): { host: string; root: string } | undefined {
    const mounted = [project, ...this.readOnlyPaths].flatMap((dir) => [dir, realpath(dir) ?? dir]);
    if (mounted.some((dir) => isWithin(dir, p))) return undefined;
    for (const [dir, name] of Object.entries(TEMP_DIRS)) {
      if (!isWithin(dir, p)) continue;
      const root = path.join(this.privateTemp(), name);
      return { host: path.join(root, p.slice(dir.length)), root };
    }
    return undefined;
  }

  promptNotes(project: string): string[] {
    const outside = (dirs: string[]) => dirs.filter((dir) => !isWithin(dir, project)).map(tildify);
    const shown = outside(this.home.show);
    const writable = outside(this.home.writable);
    const visible = [shown.length && `${shown.join(", ")} (read-only)`, writable.length && `${writable.join(", ")} (writable, and kept)`].filter(Boolean);
    return [
      "Shell commands and the file tools run in a sandbox (bubblewrap). Only the working directory, /tmp and the home folder (below) are writable; /tmp is private to this session and kept between commands. Everything else is read-only.",
      `The home folder is a private, empty one: other projects and dotfiles aren't there${visible.length ? `, apart from ${visible.join(" and ")}` : ""}. Tools can write caches to it (~/.cache and the like); they last for the session.`,
      "System packages can't be installed. Project-local installs (node_modules, a virtualenv in the working directory) work when the network is on.",
      "The network is off unless the user turns it on (/network on). The .git folder is read-only: don't commit, the user does that.",
    ];
  }

  explainFailure(output: string, project: string): string | undefined {
    if (READ_ONLY.test(output)) {
      return "[Sandbox: only the working directory, /tmp and the private home folder are writable; the path above is outside them. Write inside the working directory or /tmp instead (e.g. a build or cache folder there). If a tool insists on a folder in home, the user can share it with sandbox.home.writable in the config.]";
    }
    const net = networkNote(output, this.network);
    if (net) return net;
    // A file in the hidden part of home that a command expected to find.
    const home = os.homedir();
    const missing = output.split("\n").find((line) => /No such file or directory/.test(line) && (line.includes(`${home}/`) || /(^|[\s'"])~\//.test(line)));
    if (missing) {
      const paths = (missing.match(/(?:~|\/)[^\s'":]+/g) ?? []).map((p) => (p.startsWith("~") ? path.join(home, p.slice(1)) : p));
      if (paths.some((p) => this.hiddenHomePath(p, project))) {
        return "[Sandbox: the home folder is hidden apart from the working directory and a few shown folders, so that file may exist but isn't visible here. Ask the user if you need it; they can show folders with sandbox.home.show.]";
      }
    }
    return undefined;
  }

  dispose(): void {
    if (this.tempRoot) removeTree(this.tempRoot);
    this.tempRoot = undefined;
  }

  /** Whether a path is in the home folder but not in anything shown there. */
  private hiddenHomePath(file: string, project: string): boolean {
    const home = os.homedir();
    const shown = [project, ...this.readOnlyPaths, ...this.home.show, ...this.home.writable];
    return isWithin(home, file) && !shown.some((dir) => isWithin(dir, file));
  }

  /** The host folder behind the sandbox's /tmp, /var/tmp and home: private to this run, removed at exit. */
  private privateTemp(): string {
    if (this.tempRoot) return this.tempRoot;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "smith-"));
    for (const name of [...Object.values(TEMP_DIRS), "home"]) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    process.once("exit", () => removeTree(root));
    this.tempRoot = root;
    return root;
  }
}

/**
 * Folders on PATH inside the home folder (e.g. ~/.local/opt/node/bin), so
 * your own tools keep working while the rest of home is hidden. For a "bin"
 * folder its parent is shown, since tools find their libraries there
 * (~/.cargo, ~/go), except for ~/bin and ~/.local/bin, whose parents hold
 * much more.
 */
function pathFoldersInHome(): string[] {
  const home = os.homedir();
  const folders = new Set<string>();
  for (const entry of (process.env.PATH ?? "").split(":")) {
    if (!entry || !isWithin(home, entry) || entry === home || !fs.existsSync(entry)) continue;
    const parent = path.dirname(entry);
    const tooBroad = parent === home || parent === path.join(home, ".local");
    folders.add(path.basename(entry) === "bin" && !tooBroad ? parent : entry);
  }
  return [...folders];
}

function tildify(p: string): string {
  const home = os.homedir();
  return isWithin(home, p) ? `~${p.slice(home.length)}` : p;
}

/** Whether `p` is `dir` or inside it. */
function isWithin(dir: string, p: string): boolean {
  return p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

/**
 * The command that runs each shell command under the limits: systemd-run in
 * a scope of its own when your user's systemd can do that (memory, processes
 * and CPU), else prlimit (processes only).
 */
function limiterFor(limits: Limits | undefined, warnings: string[]): string[] {
  if (!limits || (!limits.memory && !limits.processes && !limits.cpus)) return [];
  if (systemdScopes()) {
    const props: string[] = [];
    // Swap counts too, or a command could get past the limit by swapping.
    if (limits.memory) props.push("-p", `MemoryMax=${limits.memory}`, "-p", "MemorySwapMax=0");
    if (limits.processes) props.push("-p", `TasksMax=${limits.processes}`);
    if (limits.cpus) props.push("-p", `CPUQuota=${Math.round(limits.cpus * 100)}%`);
    // systemd-run needs the session's bus address; env -u keeps it out of the sandbox.
    return ["systemd-run", "--user", "--scope", "--quiet", ...props, "--", "env", "-u", "DBUS_SESSION_BUS_ADDRESS", "-u", "XDG_RUNTIME_DIR"];
  }
  const missing = [limits.memory && "memory", limits.cpus && "cpus"].filter(Boolean);
  if (missing.length) {
    warnings.push(`The sandbox's ${missing.join(" and ")} limit needs systemd-run --user --scope, which doesn't work here; only the process limit applies.`);
  }
  return limits.processes ? ["prlimit", `--nproc=${limits.processes}`, "--"] : [];
}

let scopesWork: boolean | undefined;
function systemdScopes(): boolean {
  scopesWork ??= spawnSync("systemd-run", ["--user", "--scope", "--quiet", "-p", "TasksMax=100", "true"], { stdio: "ignore", timeout: 5_000 }).status === 0;
  return scopesWork;
}

/** Runs a spawn spec to completion, with `input` on stdin. */
export function run(spec: SpawnSpec, input?: string): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(spec.file, spec.args, { env: spec.env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let stderr = "";
    child.stdout!.on("data", (c: Buffer) => out.push(c));
    child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => resolve({ code: null, stdout: Buffer.alloc(0), stderr: err.message }));
    child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
    if (input !== undefined) {
      child.stdin!.on("error", () => {}); // It exited early; the exit code says why.
      child.stdin!.end(input);
    }
  });
}

/** An fs-style error (with `code`) from what cat, mkdir or bash printed. */
export function fileError(stderr: string, file: string, op: "open" | "write"): NodeJS.ErrnoException {
  const known: [RegExp, string, string][] = [
    [/No such file or directory/, "ENOENT", `ENOENT: no such file or directory, ${op} '${file}'`],
    [/Is a directory/, "EISDIR", `EISDIR: illegal operation on a directory, ${op} '${file}'`],
    [/Not a directory/, "ENOTDIR", `ENOTDIR: not a directory, ${op} '${file}'`],
    [/Permission denied/, "EACCES", `EACCES: permission denied, ${op} '${file}'`],
    [/Read-only file system/, "EROFS", `Can't write ${file}: the sandbox only allows writes inside the project and /tmp.`],
    [/[Nn]o such container|is not running/, "ESRCH", `The container stopped; run the command again to start a new one.`],
  ];
  const match = known.find(([pattern]) => pattern.test(stderr));
  if (!match) return new Error(stderr.trim() || `Could not ${op === "open" ? "read" : "write"} ${file}`);
  return Object.assign(new Error(match[2]), { code: match[1] });
}

/** Deletes a folder even when it holds read-only directories (as some build tools leave). */
export function removeTree(dir: string): void {
  spawnSync("chmod", ["-R", "u+w", dir], { stdio: "ignore" });
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best effort: it's under the system temp folder.
  }
}

export interface BwrapOptions {
  network: boolean;
  /** Extra folders made visible read-only, after the hiding rules. */
  readOnlyPaths?: string[];
  /** Host folder whose tmp/ and var-tmp/ become /tmp and /var/tmp; without it they're empty and per command. */
  tempRoot?: string;
  /** Where the command starts; the project by default. */
  chdir?: string;
  /**
   * Hides the home folder behind `private` (a folder of this run's own),
   * then shows `show` read-only and `writable` read-write on top.
   */
  home?: { private: string; show: string[]; writable: string[] };
}

export function bwrapArgs(cwdGiven: string, { network, readOnlyPaths = [], tempRoot, chdir, home: homeView }: BwrapOptions): string[] {
  // bwrap mounts at paths as given and can't create mount points through
  // symlinks, so every path is resolved to where it really is first.
  const cwd = realpath(cwdGiven) ?? cwdGiven;
  const args = ["--unshare-all"];
  if (network) args.push("--share-net");
  args.push("--die-with-parent", "--new-session");

  // Mounts apply in order, each on top of the previous ones.
  args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc");
  for (const dir of HIDDEN_SYSTEM_DIRS) {
    if (!isDirectory(dir)) continue;
    const temp = TEMP_DIRS[dir];
    if (temp && tempRoot) args.push("--bind", path.join(tempRoot, temp), dir);
    else args.push("--tmpfs", dir);
  }

  // The home folder: a private, empty one, with only the chosen folders shown.
  const home = os.homedir();
  if (homeView) {
    args.push("--bind", homeView.private, realpath(home) ?? home);
    for (const dir of homeView.show) {
      const real = realpath(dir);
      if (real) args.push("--ro-bind", real, real);
    }
    for (const dir of homeView.writable) {
      const real = realpath(dir);
      if (real) args.push("--bind", real, real);
    }
  }

  // Read-only folders around the project (the repository it's a subfolder
  // of) go first, so the project stays writable on top of them.
  const readOnly = readOnlyPaths.map((dir) => realpath(dir)).filter((dir): dir is string => Boolean(dir && isDirectory(dir)));
  const around = (dir: string) => cwd === dir || cwd.startsWith(`${dir}/`);
  for (const dir of readOnly.filter(around)) args.push("--ro-bind", dir, dir);

  // The one writable place. Bound after the system masks so a project under
  // /tmp or /mnt (or home) stays visible, and before the home masks so a
  // project at the home directory doesn't re-expose ~/.ssh and friends.
  args.push("--bind", cwd, cwd);

  for (const rel of HIDDEN_HOME_PATHS) hide(args, path.join(home, rel));

  // Others (skill folders) after the masks, so a skill in a hidden ~/.claude still runs.
  for (const dir of readOnly.filter((dir) => !around(dir))) args.push("--ro-bind", dir, dir);

  const git = path.join(cwd, ".git");
  if (fs.existsSync(git)) args.push("--ro-bind", git, git);

  // With the network on, DNS must still work when resolv.conf points into a
  // hidden directory (systemd-resolved under /run, WSL under /mnt).
  if (network) {
    try {
      const resolv = fs.realpathSync("/etc/resolv.conf");
      if (resolv !== "/etc/resolv.conf") args.push("--ro-bind", resolv, resolv);
    } catch {
      // No resolv.conf; nothing to do.
    }
  }

  args.push("--chdir", chdir ?? cwd);
  return args;
}

/**
 * Hides a path: an empty folder over a directory, /dev/null over a file.
 * Symlinks (e.g. ~/.npmrc or ~/.config managed by a dotfiles repository) are
 * followed, and the real location is hidden, so the link leads to nothing.
 * A missing path or a broken link has nothing to hide.
 */
function hide(args: string[], target: string): void {
  const real = realpath(target);
  if (!real) return;
  if (isDirectory(real)) args.push("--tmpfs", real);
  else args.push("--ro-bind", "/dev/null", real);
}

function realpath(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Returns why bwrap can't be used here, or null if it works. */
function probeBwrap(): string | null {
  const probe = spawnSync("bwrap", ["--unshare-all", "--die-with-parent", "--ro-bind", "/", "/", "--", "true"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (probe.error) {
    return (probe.error as NodeJS.ErrnoException).code === "ENOENT"
      ? "bubblewrap (bwrap) is not installed"
      : probe.error.message;
  }
  if (probe.status !== 0) {
    const detail = probe.stderr.trim() || `exit code ${probe.status}`;
    return `bwrap failed (${detail}); unprivileged user namespaces may be disabled (sysctl user.max_user_namespaces)`;
  }
  return null;
}
