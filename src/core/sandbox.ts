import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Runs shell commands inside bubblewrap (bwrap), the same unprivileged
 * sandbox Flatpak uses. Inside the sandbox:
 *
 * - The whole filesystem is read-only, except the project directory and a
 *   private, empty /tmp.
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

export type SandboxMode = "auto" | "on" | "off";

const ENV_ALLOW =
  /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TZ|LANG|LANGUAGE|LC_[A-Z_]+|COLORTERM|NO_COLOR|FORCE_COLOR|CI|EDITOR|JAVA_HOME|GOPATH|GOROOT|CARGO_HOME|RUSTUP_HOME|VIRTUAL_ENV|CONDA_PREFIX|PYTHONPATH|NODE_PATH|GEM_HOME|GEM_PATH)$/;

/** Variables holding this agent's own credentials, removed even when unsandboxed. */
const AGENT_SECRETS = ["AGENT_API_KEY", "OPENAI_API_KEY"];

/** Replaced by empty directories. /tmp and /var/tmp become private scratch space. */
const HIDDEN_SYSTEM_DIRS = ["/tmp", "/var/tmp", "/run", "/mnt", "/media"];

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
   * "auto" uses bwrap when it works and otherwise runs unsandboxed with a
   * warning; "on" refuses to start without it; "off" never sandboxes.
   */
  static create(mode: SandboxMode, network: boolean): Sandbox {
    if (mode === "off") return Sandbox.none("disabled with --sandbox off");
    const problem = probeBwrap();
    if (!problem) return new Sandbox(true, network);
    if (mode === "on") {
      throw new Error(`--sandbox on, but bubblewrap can't run: ${problem}\nOn RHEL/Fedora: sudo dnf install bubblewrap`);
    }
    return Sandbox.none(problem);
  }

  describe(): string {
    if (!this.active) return `not sandboxed (${this.reason})`;
    return `sandboxed: writes limited to the project, network ${this.network ? "on" : "off"}`;
  }

  /** How to spawn `command` with bash in `cwd`, inside the sandbox when it's active. */
  spawnSpec(command: string, cwd: string): SpawnSpec {
    if (!this.active) {
      const env = { ...process.env };
      for (const name of AGENT_SECRETS) delete env[name];
      return { file: "bash", args: ["-c", command], env };
    }
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => ENV_ALLOW.test(k)));
    env.TMPDIR = "/tmp";
    return { file: "bwrap", args: [...bwrapArgs(cwd, this.network, this.readOnlyPaths), "--", "bash", "-c", command], env };
  }
}

export function bwrapArgs(cwd: string, network: boolean, readOnlyPaths: string[] = []): string[] {
  const args = ["--unshare-all"];
  if (network) args.push("--share-net");
  args.push("--die-with-parent", "--new-session");

  // Mounts apply in order, each on top of the previous ones.
  args.push("--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc");
  for (const dir of HIDDEN_SYSTEM_DIRS) {
    if (isDirectory(dir)) args.push("--tmpfs", dir);
  }

  // The one writable place. Bound after the system masks so a project under
  // /tmp or /mnt stays visible, and before the home masks so a project at
  // the home directory doesn't re-expose ~/.ssh and friends.
  args.push("--bind", cwd, cwd);

  const home = os.homedir();
  for (const rel of HIDDEN_HOME_PATHS) hide(args, path.join(home, rel));

  for (const dir of readOnlyPaths) {
    if (isDirectory(dir)) args.push("--ro-bind", dir, dir);
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

  args.push("--chdir", cwd);
  return args;
}

function hide(args: string[], target: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return;
  }
  if (stat.isDirectory()) args.push("--tmpfs", target);
  else args.push("--ro-bind", "/dev/null", target);
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
