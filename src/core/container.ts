import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type ContainerSettings, fileError, hostEnv, type Limits, run, type Sandbox, type SpawnSpec } from "./sandbox.js";

/**
 * Runs commands in a container (podman or docker), one per project for the
 * session, removed when Smith exits:
 *
 * - The project is mounted read-write at the same path, so paths in
 *   commands and their output mean the same inside and out. Its .git is
 *   mounted read-only on top. Nothing else from this machine is visible
 *   except the mounts chosen in the config (and skill folders, read-only).
 * - Commands run as root in the container, so they can install packages.
 *   With rootless podman (or rootless docker) that root is your own user on
 *   this machine, so files created in the project are yours. With docker
 *   running as root, they run as your user instead, and can't install.
 * - Each command runs with `exec` in the running container (~0.1 s), so its
 *   /tmp and anything installed last for the session.
 * - No network unless it's turned on; switching it restarts the container.
 * - On SELinux systems mounts are relabelled for container use (:z), except
 *   for the home folder or /, where SELinux separation is turned off instead.
 */
export class ContainerSandbox implements Sandbox {
  readonly type = "container";
  readonly active = true;
  readOnlyPaths: string[] = [];
  readonly warnings: string[] = [];
  /** Running containers by project folder. */
  private readonly containers = new Map<string, Promise<string>>();
  private readonly started = new Set<string>();
  private networkOn: boolean;
  /** Whether container root is safe to use: it maps to you, not to this machine's root. */
  private readonly rootMapsToYou: boolean;

  constructor(
    private readonly settings: ContainerSettings,
    network: boolean,
    private readonly limits: Limits | undefined,
  ) {
    this.networkOn = network;
    const probe = spawnSync(settings.runtime, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (probe.error || probe.status !== 0) {
      throw new Error(
        `The sandbox is set to use containers, but ${settings.runtime} can't run: ${probe.error?.message ?? probe.stderr.trim()}\n` +
          "On RHEL: sudo dnf install podman. Or set sandbox.type to \"bwrap\" in the config file.",
      );
    }
    this.rootMapsToYou = settings.runtime === "podman" ? process.getuid?.() !== 0 : dockerIsRootless();
    if (!this.rootMapsToYou) {
      this.warnings.push(`${settings.runtime} runs as root here, so commands in the container run as your user (to keep files in the project yours) and can't install system packages.`);
    }
    for (const spec of [...settings.mounts, ...settings.projects.flatMap((p) => p.mounts)]) {
      const { source } = parseMount(spec);
      if (!fs.existsSync(source)) this.warnings.push(`The sandbox mount ${source} doesn't exist; it's skipped.`);
    }
    process.once("exit", () => this.dispose());
  }

  get network(): boolean {
    return this.networkOn;
  }

  /** A running container can't change its network: switching removes it, and the next command starts a new one. */
  set network(on: boolean) {
    if (on === this.networkOn) return;
    this.networkOn = on;
    this.dispose();
  }

  describe(project?: string): string {
    const { image, mounts } = project ? this.settingsFor(project) : { image: this.settings.image, mounts: this.settings.mounts };
    const extra = mounts.length ? ` and ${mounts.length} mount${mounts.length === 1 ? "" : "s"}` : "";
    return `in a ${this.settings.runtime} container (${image}): only the project${extra}, network ${this.networkOn ? "on" : "off"}`;
  }

  async spawnSpec(command: string, cwd: string): Promise<SpawnSpec> {
    const name = await this.container(cwd);
    // The command runs as a background job with job control on, so it gets
    // a process group of its own; its id goes to a file, so a timeout or
    // interrupt can kill the whole group inside the container.
    const pidFile = `/tmp/.smith-${randomBytes(6).toString("hex")}.pid`;
    const wrapper = 'set -m; bash -c "$1" & p=$!; set +m; echo $p > "$2"; wait $p; s=$?; rm -f "$2"; exit $s';
    const runtime = this.settings.runtime;
    return {
      file: runtime,
      args: ["exec", "-w", cwd, name, "bash", "-c", wrapper, "bash", command, pidFile],
      env: hostEnv(),
      kill: () => {
        const stop = `kill -KILL -- -"$(cat ${pidFile} 2>/dev/null)" 2>/dev/null; rm -f ${pidFile}`;
        spawn(runtime, ["exec", name, "bash", "-c", stop], { stdio: "ignore", env: hostEnv() }).on("error", () => {});
      },
    };
  }

  async programSpec(file: string, args: string[], project: string, opts: { chdir?: string } = {}): Promise<SpawnSpec> {
    const name = await this.container(project);
    return { file: this.settings.runtime, args: ["exec", "-w", opts.chdir ?? project, name, file, ...args], env: hostEnv() };
  }

  /** The project is the same folder inside and out, so it's read here; anything else comes from the container. */
  async readFile(file: string, project: string): Promise<string> {
    if (isWithin(project, file)) return fs.promises.readFile(file, "utf8");
    const { code, stdout, stderr } = await run(await this.programSpec("cat", ["--", file], project));
    if (code !== 0) throw fileError(stderr, file, "open");
    return stdout.toString("utf8");
  }

  async writeFile(file: string, content: string, project: string): Promise<void> {
    if (isWithin(project, file)) {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      return fs.promises.writeFile(file, content, "utf8");
    }
    const name = await this.container(project);
    const script = 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"';
    const spec = { file: this.settings.runtime, args: ["exec", "-i", name, "bash", "-c", script, "bash", file], env: hostEnv() };
    const { code, stderr } = await run(spec, content);
    if (code !== 0) throw fileError(stderr, file, "write");
  }

  /** Everything outside the project is the container's own, with no place on this machine. */
  sandboxPath(p: string, project: string): { host?: string; root?: string } | undefined {
    return isWithin(project, p) ? undefined : {};
  }

  dispose(): void {
    const names = [...this.started];
    this.containers.clear();
    this.started.clear();
    if (names.length) spawnSync(this.settings.runtime, ["rm", "-f", ...names], { stdio: "ignore", timeout: 30_000, env: hostEnv() });
  }

  /** The image and mounts for a project: the most specific `projects` entry containing it, else the defaults. */
  private settingsFor(project: string): { image: string; mounts: string[] } {
    const match = this.settings.projects
      .filter((p) => isWithin(p.folder, project))
      .sort((a, b) => b.folder.length - a.folder.length)[0];
    return { image: match?.image ?? this.settings.image, mounts: [...this.settings.mounts, ...(match?.mounts ?? [])] };
  }

  /** The project's container, started on first use. */
  private container(project: string): Promise<string> {
    let name = this.containers.get(project);
    if (!name) {
      name = this.start(project);
      this.containers.set(project, name);
      // A failed start is retried by the next command.
      name.catch(() => this.containers.delete(project));
    }
    return name;
  }

  private async start(project: string): Promise<string> {
    const { runtime } = this.settings;
    const { image, mounts } = this.settingsFor(project);
    const name = `smith-${randomBytes(4).toString("hex")}`;
    const home = os.homedir();

    const volumes: { source: string; target: string; readOnly: boolean }[] = [{ source: project, target: project, readOnly: false }];
    const git = path.join(project, ".git");
    if (fs.existsSync(git)) volumes.push({ source: git, target: git, readOnly: true });
    for (const dir of this.readOnlyPaths) if (fs.existsSync(dir)) volumes.push({ source: dir, target: dir, readOnly: true });
    for (const spec of mounts) {
      const mount = parseMount(spec);
      if (fs.existsSync(mount.source)) volumes.push(mount);
    }
    // Relabelling the home folder or / for containers would upset everything else using them.
    const noRelabel = volumes.some((v) => !v.readOnly && (v.source === home || v.source === "/" || v.source === path.dirname(home)));

    const args = ["run", "-d", "--rm", "--init", "--name", name, "--label", "smith=1"];
    if (this.rootMapsToYou) args.push("--user", "0:0");
    else args.push("--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, "--env", "HOME=/tmp");
    if (!this.networkOn) args.push("--network", "none");
    args.push("--security-opt", "no-new-privileges");
    if (noRelabel) args.push("--security-opt", "label=disable");
    for (const v of volumes) {
      const options = [v.readOnly && "ro", !noRelabel && v.source !== git && "z"].filter(Boolean).join(",");
      args.push("--volume", `${v.source}:${v.target}${options ? `:${options}` : ""}`);
    }
    const limits = this.limits;
    if (limits?.memory) args.push("--memory", String(limits.memory));
    if (limits?.processes) args.push("--pids-limit", String(limits.processes));
    if (limits?.cpus) args.push("--cpus", String(limits.cpus));
    args.push("--workdir", project, "--entrypoint", "sleep", image, "infinity");

    const { code, stderr } = await run({ file: runtime, args, env: hostEnv() });
    if (code !== 0) throw new Error(`Could not start a ${runtime} container from ${image}: ${stderr.trim() || `exit code ${code}`}`);
    this.started.add(name);
    return name;
  }
}

/** "src", "src:ro", "src:dst" or "src:dst:ro", with ~ expanded; the target defaults to the same path. */
export function parseMount(spec: string): { source: string; target: string; readOnly: boolean } {
  const parts = spec.split(":");
  const readOnly = parts.at(-1) === "ro" || parts.at(-1) === "rw" ? parts.pop() === "ro" : false;
  const source = expandHome(parts[0] ?? "");
  const target = parts[1] ? expandHome(parts[1]) : source;
  return { source: path.resolve(source), target: path.resolve(target), readOnly };
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}

function isWithin(dir: string, p: string): boolean {
  return p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);
}

function dockerIsRootless(): boolean {
  const info = spawnSync("docker", ["info", "--format", "{{.SecurityOptions}}"], { encoding: "utf8", timeout: 10_000 });
  return /rootless/.test(info.stdout ?? "");
}
