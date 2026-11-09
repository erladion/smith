import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runs shell commands, and the file tools' reads and writes, inside
 * bubblewrap (bwrap), the same unprivileged sandbox Flatpak uses. Inside the
 * sandbox:
 *
 * - The whole filesystem is read-only, except the project directory and a
 *   private /tmp (and /var/tmp). That /tmp starts empty and is kept for as
 *   long as the agent runs, so one command can use what another left there;
 *   it's deleted when the agent exits.
 * - Credentials and history in the home directory (~/.ssh, ~/.aws, shell
 *   history, ...) are hidden, as are /run (Docker, Podman and D-Bus sockets)
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

export type SandboxMode = "on" | "off";

const ENV_ALLOW =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TZ|LANG|LANGUAGE|LC_[A-Z_]+|COLORTERM|NO_COLOR|FORCE_COLOR|CI|EDITOR|JAVA_HOME|GOPATH|GOROOT|CARGO_HOME|RUSTUP_HOME|VIRTUAL_ENV|CONDA_PREFIX|PYTHONPATH|NODE_PATH|GEM_HOME|GEM_PATH)$/;

/** Variables holding this agent's own credentials, removed even when unsandboxed. */
const AGENT_SECRETS = ["AGENT_API_KEY", "OPENAI_API_KEY"];

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
  // This agent's own sessions and settings.
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
}

export class Sandbox {
  /**
   * Extra folders made visible read-only, after the hiding rules: skill
   * folders, so a skill's scripts can run even from a hidden ~/.claude.
   */
  readOnlyPaths: string[] = [];
  /** The host folder holding the private /tmp and /var/tmp, made on first use. */
  private tempRoot: string | undefined;

  private constructor(
    readonly active: boolean,
    /** Whether sandboxed commands can use the network. Can be changed at runtime. */
    public network: boolean,
    /** Why the sandbox is not active, when it isn't. */
    readonly reason?: string,
  ) {}

  /** No sandbox: commands run directly with bash (still without the agent's API keys). */
  static none(reason = "sandbox disabled"): Sandbox {
    return new Sandbox(false, true, reason);
  }

  /**
   * "on" (the default) requires the sandbox: if bwrap can't run, the agent
   * doesn't start. "off" never sandboxes; it has to be asked for explicitly.
   */
  static create(mode: SandboxMode, network: boolean): Sandbox {
    if (mode === "off") return Sandbox.none("disabled with --sandbox off");
    const problem = probeBwrap();
    if (problem) {
      throw new Error(
        `Shell commands run in a sandbox, but bubblewrap can't run: ${problem}\n` +
          "On RHEL/Fedora: sudo dnf install bubblewrap\n" +
          "To run without a sandbox anyway (e.g. inside a container that already isolates it), pass --sandbox off.",
      );
    }
    return new Sandbox(true, network);
  }

  describe(): string {
    if (!this.active) return `not sandboxed (${this.reason})`;
    return `sandboxed: writes limited to the project, network ${this.network ? "on" : "off"}`;
  }

  /** How to spawn `command` with bash in `cwd`, inside the sandbox when it's active. */
  spawnSpec(command: string, cwd: string): SpawnSpec {
    return this.programSpec("bash", ["-c", command], cwd, { network: this.network });
  }

  /**
   * How to run a program directly (no shell), inside the sandbox when it's
   * active. `project` is the one writable folder; the program starts in
   * `chdir` (default: the project). No network unless asked for.
   */
  programSpec(file: string, args: string[], project: string, opts: { chdir?: string; network?: boolean } = {}): SpawnSpec {
    if (!this.active) {
      const env = { ...process.env };
      for (const name of AGENT_SECRETS) delete env[name];
      return { file, args, env };
    }
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_ALLOW.test(k)));
    env.TMPDIR = "/tmp";
    const sandboxArgs = bwrapArgs(project, {
      network: opts.network ?? false,
      readOnlyPaths: this.readOnlyPaths,
      tempRoot: this.privateTemp(),
      chdir: opts.chdir,
    });
    return { file: "bwrap", args: [...sandboxArgs, "--", file, ...args], env };
  }

  /** Reads a file as sandboxed commands see it. Errors carry `code` (ENOENT, EISDIR, ...) like fs errors. */
  async readFile(file: string, project: string): Promise<string> {
    if (!this.active) return fs.promises.readFile(file, "utf8");
    const { code, stdout, stderr } = await run(this.programSpec("cat", ["--", file], project));
    if (code !== 0) throw fileError(stderr, file, "open");
    return stdout.toString("utf8");
  }

  /** Writes a file, creating its folder, inside the sandbox: only the project (and the private /tmp) are writable. */
  async writeFile(file: string, content: string, project: string): Promise<void> {
    if (!this.active) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      return fs.promises.writeFile(file, content, "utf8");
    }
    const script = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';
    const { code, stderr } = await run(this.programSpec("bash", ["-c", script, "bash", file], project), content);
    if (code !== 0) throw fileError(stderr, file, "write");
  }

  /** The host folder behind the sandbox's /tmp and /var/tmp: private to this run, removed at exit. */
  private privateTemp(): string {
    if (this.tempRoot) return this.tempRoot;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-"));
    for (const name of Object.values(TEMP_DIRS)) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    process.once("exit", () => removeTree(root));
    this.tempRoot = root;
    return root;
  }
}

/** Runs a spawn spec to completion, with `input` on stdin. */
function run(spec: SpawnSpec, input?: string): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
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
function fileError(stderr: string, file: string, op: "open" | "write"): NodeJS.ErrnoException {
  const known: [RegExp, string, string][] = [
    [/No such file or directory/, "ENOENT", `ENOENT: no such file or directory, ${op} '${file}'`],
    [/Is a directory/, "EISDIR", `EISDIR: illegal operation on a directory, ${op} '${file}'`],
    [/Not a directory/, "ENOTDIR", `ENOTDIR: not a directory, ${op} '${file}'`],
    [/Permission denied/, "EACCES", `EACCES: permission denied, ${op} '${file}'`],
    [/Read-only file system/, "EROFS", `Can't write ${file}: the sandbox only allows writes inside the project and /tmp.`],
  ];
  const match = known.find(([pattern]) => pattern.test(stderr));
  if (!match) return new Error(stderr.trim() || `Could not ${op === "open" ? "read" : "write"} ${file}`);
  return Object.assign(new Error(match[2]), { code: match[1] });
}

/** Deletes a folder even when it holds read-only directories (as some build tools leave). */
function removeTree(dir: string): void {
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
}

export function bwrapArgs(cwdGiven: string, { network, readOnlyPaths = [], tempRoot, chdir }: BwrapOptions): string[] {
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

  // The one writable place. Bound after the system masks so a project under
  // /tmp or /mnt stays visible, and before the home masks so a project at
  // the home directory doesn't re-expose ~/.ssh and friends.
  args.push("--bind", cwd, cwd);

  const home = os.homedir();
  for (const rel of HIDDEN_HOME_PATHS) hide(args, path.join(home, rel));

  for (const dir of readOnlyPaths) {
    const real = realpath(dir);
    if (real && isDirectory(real)) args.push("--ro-bind", real, real);
  }

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
