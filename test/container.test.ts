// Runs real commands in containers with docker. Skipped unless docker works
// and the ubi9 images are already on this machine (the tests don't pull).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { parseMount } from "../src/core/container.js";
import { Sandbox } from "../src/core/sandbox.js";
import { bash } from "../src/core/tools/bash.js";
import { editFile, readFile, writeFile } from "../src/core/tools/files.js";
import { glob, grep, list } from "../src/core/tools/search.js";
import type { ToolDef } from "../src/core/tool.js";

const MINIMAL = "registry.access.redhat.com/ubi9/ubi-minimal:latest";
const FULL = "registry.access.redhat.com/ubi9/ubi:latest";
const hasImage = (image: string) => spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0;
const available = hasImage(MINIMAL) && hasImage(FULL);

const ours = () =>
  spawnSync("docker", ["ps", "-q", "--filter", "label=smith=1"], { encoding: "utf8" })
    .stdout.split("\n")
    .filter(Boolean);

test("mounts are read as the config writes them", () => {
  const home = os.homedir();
  assert.deepEqual(parseMount("~/.m2/repository"), { source: `${home}/.m2/repository`, target: `${home}/.m2/repository`, readOnly: false });
  assert.deepEqual(parseMount("~/.gitconfig:ro"), { source: `${home}/.gitconfig`, target: `${home}/.gitconfig`, readOnly: true });
  assert.deepEqual(parseMount("/data/x:/opt/x:ro"), { source: "/data/x", target: "/opt/x", readOnly: true });
});

describe("the container sandbox", { skip: !available && "docker or the ubi9 images aren't available" }, () => {
  let base: string;
  let project: string;
  let shared: string;
  let sandbox: Sandbox;
  const before_ = new Set<string>();
  const ctx = () => ({ cwd: project, signal: new AbortController().signal, sandbox });
  const call = (tool: ToolDef, input: unknown) => tool.run(tool.schema.parse(input), ctx());
  const sh = async (command: string, timeout_ms?: number) => (await call(bash, { command, timeout_ms })).content;

  before(() => {
    for (const id of ours()) before_.add(id);
    base = fs.mkdtempSync(path.join(os.tmpdir(), "smith-container-"));
    project = path.join(base, "project");
    shared = path.join(base, "shared");
    fs.mkdirSync(path.join(project, ".git"), { recursive: true });
    fs.writeFileSync(path.join(project, ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(project, "hello.txt"), "hi\n");
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, "dep.txt"), "a dependency\n");
    fs.writeFileSync(path.join(base, "secret.txt"), "hunter2");
    sandbox = Sandbox.create({
      type: "container",
      network: false,
      limits: { processes: 256 },
      container: { runtime: "docker", image: MINIMAL, mounts: [`${shared}:ro`, `${base}/missing`], projects: [] },
    });
  });
  after(() => {
    sandbox.dispose();
    fs.rmSync(base, { recursive: true, force: true });
  });

  test("commands run in the image, in the project, with only the project and mounts from here", async () => {
    assert.match(await sh("cat /etc/os-release"), /Red Hat Enterprise Linux/);
    assert.equal(await sh("pwd"), project);
    assert.match(await sh("cat hello.txt; echo made > made.txt; cat made.txt"), /^hi\nmade$/);
    assert.equal(fs.statSync(path.join(project, "made.txt")).uid, process.getuid!(), "files made in the project are yours");
    assert.match(await sh(`cat ${base}/secret.txt 2>&1`), /No such file or directory/);
    assert.match(await sh(`cat ${shared}/dep.txt; touch ${shared}/x 2>&1`), /a dependency\n.*Read-only file system/);
    assert.match(await sh("echo x >> .git/config 2>&1; echo end"), /Read-only file system/);
    assert.equal(fs.readFileSync(path.join(project, ".git", "config"), "utf8"), "[core]\n");
    assert.equal(await sh("ls /sys/class/net"), "lo", "no network but loopback");
    assert.match(sandbox.warnings.join("\n"), /missing doesn't exist; it's skipped/);
    assert.match(sandbox.describe(project), /in a docker container \(.*ubi-minimal.*\): only the project and 2 mounts, network off/);
  });

  test("it describes itself to the model, and explains failures it causes", async () => {
    const notes = sandbox.promptNotes(project).join("\n");
    assert.match(notes, /docker container from the image .*ubi-minimal/);
    assert.match(notes, /as the user's own account/, "root docker: commands run as you");
    assert.match(notes, new RegExp(`and ${shared} \\(read-only\\)`));
    assert.match(await sh(`touch ${shared}/x`), /\[Sandbox: the path above is read-only in the container/);
    assert.match(sandbox.explainFailure("Error: This command has to be run with superuser privileges (under the root user on most systems). Permission denied", project) ?? "", /installing system packages isn't possible/);
  });

  test("one container for the session: /tmp and the like last between commands", async () => {
    await sh("echo kept > /tmp/state");
    assert.equal(await sh("cat /tmp/state"), "kept");
    assert.equal(ours().filter((id) => !before_.has(id)).length, 1);
  });

  test("the file tools: the project directly, everything else from the container, without asking", async () => {
    assert.match((await call(writeFile, { path: "src/a.txt", content: "alpha\n" })).content, /Created src\/a\.txt/);
    assert.match((await call(editFile, { path: "src/a.txt", old_string: "alpha", new_string: "beta" })).content, /Replaced 1/);
    assert.equal(await sh("cat src/a.txt"), "beta");

    assert.equal(await readFile.approvalReason!(readFile.schema.parse({ path: "/etc/os-release" }), ctx()), undefined);
    assert.match((await call(readFile, { path: "/etc/os-release" })).content, /Red Hat/);
    await sh("mkdir -p /tmp/logs && echo 'error: boom' > /tmp/logs/build.log");
    assert.match((await call(readFile, { path: "/tmp/logs/build.log" })).content, /error: boom/);
    assert.match((await call(glob, { pattern: "*.log", path: "/tmp/logs" })).content, /build\.log/);
    assert.match((await call(grep, { pattern: "boom", path: "/tmp/logs" })).content, /build\.log:1:error: boom/);
    assert.match((await call(list, { path: "/tmp/logs" })).content, /^\/tmp\/logs\/ \(1 file\)\n {2}build\.log$/);
    // In the project, searches run here.
    assert.match((await call(grep, { pattern: "beta" })).content, /src\/a\.txt:1:beta/);
    assert.match((await call(glob, { pattern: "**/*.txt" })).content, /hello\.txt/);
  });

  test("a timeout kills the command and everything it started, inside the container", async () => {
    const started = Date.now();
    const out = await sh("sleep 60 & sleep 60; echo never", 1500);
    assert.match(out, /timed out/);
    assert.ok(Date.now() - started < 10_000);
    await new Promise((r) => setTimeout(r, 500));
    const left = await sh("for p in /proc/[0-9]*; do tr '\\0' ' ' < $p/cmdline 2>/dev/null; echo; done | grep -c '^sleep 60' || true");
    assert.equal(left, "0");
  });

  test("switching the network starts a new container; dispose removes them", async () => {
    const first = await sh("cat /etc/hostname");
    sandbox.network = true;
    assert.notEqual(await sh("cat /etc/hostname"), first);
    assert.notEqual(await sh("ls /sys/class/net"), "lo");
    sandbox.network = false;
    sandbox.dispose();
    assert.deepEqual(ours().filter((id) => !before_.has(id)), []);
  });

  test("a project can have its own image", async () => {
    const own = Sandbox.create({
      type: "container",
      network: false,
      container: { runtime: "docker", image: MINIMAL, mounts: [], projects: [{ folder: base, image: FULL, mounts: [] }] },
    });
    try {
      const res = await (bash as ToolDef).run(bash.schema.parse({ command: "command -v dnf microdnf" }), { cwd: project, signal: new AbortController().signal, sandbox: own });
      assert.match(res.content, /\/dnf/);
      assert.doesNotMatch(res.content, /microdnf/);
    } finally {
      own.dispose();
    }
  });
});

describe("variables in the container", { skip: !available && "docker or the ubi9 images aren't available" }, () => {
  test("sandbox.env reaches commands; proxies only with the network on", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smith-container-env-"));
    const saved = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://proxy.example:3128";
    const sandbox = Sandbox.create({
      type: "container",
      network: false,
      env: ["BUILD_MODE=release"],
      container: { runtime: "docker", image: MINIMAL, mounts: [], projects: [] },
    });
    try {
      const sh = async (command: string) => (await (bash as ToolDef).run(bash.schema.parse({ command }), { cwd: dir, signal: new AbortController().signal, sandbox })).content;
      assert.equal(await sh('echo "$BUILD_MODE|$HTTPS_PROXY"'), "release|");
      sandbox.network = true;
      assert.equal(await sh('echo "$BUILD_MODE|$HTTPS_PROXY"'), "release|http://proxy.example:3128");
    } finally {
      sandbox.dispose();
      if (saved === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
