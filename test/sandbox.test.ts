// Runs real commands through bubblewrap. Skipped where bwrap can't run.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { Sandbox } from "../src/core/sandbox.js";
import { bash } from "../src/core/tools/bash.js";
import { editFile, readFile, writeFile } from "../src/core/tools/files.js";
import { glob, grep } from "../src/core/tools/search.js";
import type { ToolDef } from "../src/core/tool.js";

let available = true;
try {
  Sandbox.create({ type: "bwrap", network: false });
} catch {
  available = false;
}

describe("bash in the sandbox", { skip: !available && "bwrap is not available" }, () => {
  let home: string;
  let project: string;
  let outside: string;
  const originalHome = process.env.HOME;

  const run = (command: string, opts: { network?: boolean; cwd?: string; timeout_ms?: number } = {}) => {
    const sandbox = Sandbox.create({ type: "bwrap", network: opts.network ?? false });
    const tool = bash as ToolDef;
    const input = tool.schema.parse({ command, timeout_ms: opts.timeout_ms });
    return tool.run(input, { cwd: opts.cwd ?? project, signal: new AbortController().signal, sandbox });
  };

  before(() => {
    // A fake home with credentials in it; the project lives inside it, which
    // checks that binding the project doesn't re-expose the hidden paths.
    home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-home-"));
    fs.mkdirSync(path.join(home, ".ssh"));
    fs.writeFileSync(path.join(home, ".ssh", "id_ed25519"), "PRIVATE KEY");
    fs.writeFileSync(path.join(home, ".netrc"), "machine x password hunter2");
    project = home;
    fs.mkdirSync(path.join(project, ".git", "hooks"), { recursive: true });
    fs.writeFileSync(path.join(project, ".git", "config"), "[core]\n");
    fs.writeFileSync(path.join(project, "hello.txt"), "hi\n");
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-outside-"));
    process.env.HOME = home;
  });
  after(() => {
    process.env.HOME = originalHome;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("the project is readable and writable", async () => {
    const res = await run("cat hello.txt && echo new > made.txt && cat made.txt");
    assert.equal(res.isError, undefined, res.content);
    assert.equal(res.content, "hi\nnew");
    assert.equal(fs.readFileSync(path.join(project, "made.txt"), "utf8"), "new\n");
  });

  test("everything outside the project is read-only or hidden", async () => {
    const res = await run(`touch /usr/agent-test 2>&1; ls -A ${outside} 2>&1; ls -A /run /mnt 2>/dev/null | grep -v : ; echo done`);
    assert.match(res.content, /Read-only file system/);
    assert.match(res.content, /No such file or directory/, "other /tmp directories are not visible");
    assert.match(res.content, /done$/);
    assert.doesNotMatch(res.content, /WSL|docker|dbus|wsl/);
  });

  test("credentials in the home directory are hidden", async () => {
    const res = await run("ls -A ~/.ssh; cat ~/.netrc; echo end");
    // ~/.ssh is an empty directory; ~/.netrc is covered by an unreadable placeholder.
    assert.doesNotMatch(res.content, /id_ed25519|hunter2/);
    assert.match(res.content, /end$/);
  });

  test(".git is read-only", async () => {
    const res = await run("echo '[core] fsmonitor = evil' >> .git/config; mv .git .git-old; touch .git/hooks/pre-commit; echo end");
    assert.match(res.content, /Read-only file system|Device or resource busy/);
    assert.equal(fs.readFileSync(path.join(project, ".git", "config"), "utf8"), "[core]\n");
    assert.ok(fs.existsSync(path.join(project, ".git")));
    assert.ok(!fs.existsSync(path.join(project, ".git", "hooks", "pre-commit")));
  });

  test("secrets in the environment are not passed in", async () => {
    process.env.AGENT_API_KEY = "sk-agent";
    process.env.GITHUB_TOKEN = "ghp_secret";
    try {
      const res = await run("env");
      assert.doesNotMatch(res.content, /sk-agent|ghp_secret/);
      assert.match(res.content, /^PATH=/m);
    } finally {
      delete process.env.AGENT_API_KEY;
      delete process.env.GITHUB_TOKEN;
    }
  });

  test("hidden paths that are symlinks are followed, not a reason to fail", async () => {
    // Dotfile managers make ~/.npmrc or the whole ~/.config a symlink into a repository.
    const dotfiles = fs.mkdtempSync(path.join(os.homedir(), ".agent-dotfiles-"));
    try {
      fs.mkdirSync(path.join(dotfiles, "config", "gh"), { recursive: true });
      fs.writeFileSync(path.join(dotfiles, "config", "gh", "hosts.yml"), "token: SECRET-gh");
      fs.writeFileSync(path.join(dotfiles, "npmrc"), "SECRET-npm");
      fs.symlinkSync(path.join(dotfiles, "config"), path.join(home, ".config"));
      fs.symlinkSync(path.join(dotfiles, "npmrc"), path.join(home, ".npmrc"));
      fs.symlinkSync(path.join(dotfiles, "missing"), path.join(home, ".pypirc"));
      const res = await run("cat ~/.npmrc ~/.config/gh/hosts.yml 2>/dev/null; echo end");
      assert.equal(res.isError, undefined, res.content);
      assert.doesNotMatch(res.content, /SECRET/);
    } finally {
      for (const link of [".config", ".npmrc", ".pypirc"]) fs.rmSync(path.join(home, link), { force: true });
      fs.rmSync(dotfiles, { recursive: true, force: true });
    }
  });

  test("the network is blocked unless enabled", async () => {
    const server = http.createServer((_, res) => res.end("ok"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const probe = `(exec 3<>/dev/tcp/127.0.0.1/${port}) 2>/dev/null && echo connected || echo blocked`;
    try {
      assert.equal((await run(probe)).content, "blocked");
      assert.equal((await run(probe, { network: true })).content, "connected");
    } finally {
      server.close();
    }
  });

  test("/tmp is private, starts empty, and is kept between commands", async () => {
    const sandbox = Sandbox.create({ type: "bwrap", network: false });
    const ctx = { cwd: project, signal: new AbortController().signal, sandbox };
    const tool = bash as ToolDef;
    const sh = (command: string) => tool.run(tool.schema.parse({ command }), ctx);
    // Empty but for the test project, which lives under /tmp here and is mounted in.
    const listing = (await sh(`ls -A /tmp /var/tmp | grep -v : | grep -vx ${path.basename(project)} | grep . ; echo end`)).content;
    assert.equal(listing, "end", "starts empty");
    await sh("echo kept > /tmp/a && echo also > /var/tmp/b");
    assert.equal((await sh("cat /tmp/a /var/tmp/b")).content, "kept\nalso");
    // Another sandbox (another agent) has its own.
    assert.match((await run("cat /tmp/a 2>&1")).content, /No such file or directory/);
  });

  test("the file tools read and write through the sandbox", async () => {
    const sandbox = Sandbox.create({ type: "bwrap", network: false });
    const ctx = { cwd: project, signal: new AbortController().signal, sandbox };
    const call = (tool: ToolDef, input: unknown) => tool.run(tool.schema.parse(input), ctx);

    const wrote = await call(writeFile, { path: "deep/er/new.txt", content: "fresh\n" });
    assert.equal(wrote.isError, undefined, wrote.content);
    assert.equal(fs.readFileSync(path.join(project, "deep/er/new.txt"), "utf8"), "fresh\n");
    assert.match((await call(editFile, { path: "deep/er/new.txt", old_string: "fresh", new_string: "edited" })).content, /Replaced 1 occurrence/);
    assert.match((await call(readFile, { path: "deep/er/new.txt" })).content, /^1\tedited$/);
    await assert.rejects(call(readFile, { path: "missing.txt" }), { code: "ENOENT" });

    // What the sandbox hides or protects stays so, whatever the path checks let through.
    const netrc = await sandbox.readFile(path.join(home, ".netrc"), project).catch((err: Error) => err.message);
    assert.doesNotMatch(netrc, /hunter2/);
    await assert.rejects(sandbox.writeFile("/usr/agent-test/x.txt", "x", project), /only allows writes inside the project/);
    await assert.rejects(sandbox.writeFile(path.join(project, ".git", "config"), "evil", project), /only allows writes inside the project/);
    assert.equal(fs.readFileSync(path.join(project, ".git", "config"), "utf8"), "[core]\n");

    // Listing and searching run in it too: hidden folders list as empty.
    const listed = (await call(glob, { pattern: "**/*" })).content;
    assert.match(listed, /hello\.txt/);
    assert.doesNotMatch(listed, /id_ed25519/);
    assert.match((await call(grep, { pattern: "edited" })).content, /deep\/er\/new\.txt:1:edited/);
    assert.equal((await call(grep, { pattern: "PRIVATE KEY", path: ".ssh" })).content, "No matches.");
  });

  test("the file tools can read the session's /tmp, without asking", async () => {
    const sandbox = Sandbox.create({ type: "bwrap", network: false });
    const ctx = { cwd: project, signal: new AbortController().signal, sandbox };
    const call = (tool: ToolDef, input: unknown) => tool.run(tool.schema.parse(input), ctx);
    const reason = (tool: ToolDef, input: unknown) => tool.approvalReason?.(tool.schema.parse(input), ctx);
    await call(bash, { command: `mkdir -p /tmp/out && echo "error: boom" > /tmp/out/log.txt && ln -s /usr/share /tmp/away` });

    assert.equal(await reason(readFile, { path: "/tmp/out/log.txt" }), undefined, "no approval needed");
    assert.match((await call(readFile, { path: "/tmp/out/log.txt" })).content, /^1\terror: boom$/);
    assert.match((await call(glob, { pattern: "*.txt", path: "/tmp/out" })).content, /log\.txt/);
    assert.match((await call(grep, { pattern: "boom", path: "/tmp/out" })).content, /log\.txt:1:error: boom/);
    // A link out of it is a read outside the project, which asks.
    assert.ok(await reason(readFile, { path: "/tmp/away/x" }));
    // Without a sandbox, /tmp is the machine's own and stays off limits.
    await assert.rejects(readFile.run(readFile.schema.parse({ path: "/tmp/out/log.txt" }), { cwd: project, signal: ctx.signal }), /off limits/);
  });

  test("a timed-out command is killed with everything it started", async () => {
    const started = Date.now();
    const res = await run("sleep 30 & sleep 30", { timeout_ms: 300 });
    assert.equal(res.isError, true);
    assert.match(res.content, /timed out/);
    assert.ok(Date.now() - started < 5_000);
  });
});

describe("the home folder in the bwrap sandbox", { skip: !available && "bwrap is not available" }, () => {
  let home: string;
  let repo: string;
  let project: string;
  const saved = { HOME: process.env.HOME, PATH: process.env.PATH };
  const ctxFor = (sandbox: Sandbox) => ({ cwd: project, signal: new AbortController().signal, sandbox });
  const sh = (sandbox: Sandbox, command: string) => (bash as ToolDef).run(bash.schema.parse({ command }), ctxFor(sandbox));

  before(() => {
    // A home with a repository whose subfolder is the project, another
    // project with a secret, a tool on PATH, a cache and a shown folder.
    home = fs.mkdtempSync(path.join(os.tmpdir(), "smith-home-"));
    repo = path.join(home, "work");
    project = path.join(repo, "app");
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "repo readme\n");
    fs.mkdirSync(path.join(home, "other"));
    fs.writeFileSync(path.join(home, "other", "secret.txt"), "hunter2");
    fs.mkdirSync(path.join(home, "tools", "bin"), { recursive: true });
    fs.writeFileSync(path.join(home, "tools", "bin", "mytool"), "#!/bin/sh\necho tool ran\n", { mode: 0o755 });
    fs.writeFileSync(path.join(home, "tools", "lib.txt"), "lib");
    fs.mkdirSync(path.join(home, "shown"));
    fs.writeFileSync(path.join(home, "shown", "notes.txt"), "shown notes");
    process.env.HOME = home;
    process.env.PATH = `${path.join(home, "tools", "bin")}:${saved.PATH}`;
  });
  after(() => {
    process.env.HOME = saved.HOME;
    process.env.PATH = saved.PATH;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const create = () => {
    const sandbox = Sandbox.create({
      type: "bwrap",
      network: false,
      home: { show: [path.join(home, "shown")], writable: [path.join(home, "cache")] },
    });
    sandbox.readOnlyPaths = [repo];
    return sandbox;
  };

  test("only the project, tools on PATH and chosen folders show; the rest of home is private", async () => {
    const sandbox = create();
    const out = (await sh(sandbox, `cat ~/other/secret.txt 2>&1; mytool; cat ~/tools/lib.txt ~/shown/notes.txt; echo; touch ~/shown/x 2>&1; echo end`)).content;
    assert.doesNotMatch(out, /hunter2/);
    assert.match(out, /No such file or directory/);
    assert.match(out, /tool ran\nlib/, "a bin folder on PATH shows with its parent");
    assert.match(out, /shown notes/);
    assert.match(out, /Read-only file system/);

    // Home itself is writable, privately, and kept between commands.
    await sh(sandbox, "mkdir -p ~/.cache/build && echo cached > ~/.cache/build/x && echo kept > ~/cache/y");
    assert.equal((await sh(sandbox, "cat ~/.cache/build/x")).content, "cached");
    assert.ok(!fs.existsSync(path.join(home, ".cache")), "the private home isn't the real one");
    assert.equal(fs.readFileSync(path.join(home, "cache", "y"), "utf8"), "kept\n", "writable folders are the real ones");

    // The file tools say why a home file is missing.
    await assert.rejects(sandbox.readFile(path.join(home, "other", "secret.txt"), project), /home folder is hidden in the sandbox/);
    sandbox.dispose();
  });

  test("the repository around the project is readable, and the project stays writable", async () => {
    const sandbox = create();
    const out = (await sh(sandbox, "cat ../README.md; touch ../new 2>&1; echo made > here.txt && cat here.txt")).content;
    assert.match(out, /repo readme/);
    assert.match(out, /Read-only file system/);
    assert.match(out, /made$/);
    sandbox.dispose();
  });

  test("limits apply to shell commands", async () => {
    const sandbox = Sandbox.create({ type: "bwrap", network: false, limits: { processes: 64 } });
    const spec = await sandbox.spawnSpec("true", project);
    if (spec.file === "prlimit") {
      assert.equal((await sh(sandbox, "ulimit -u")).content, "64");
    } else {
      assert.equal(spec.file, "systemd-run");
      assert.ok(spec.args.includes("TasksMax=64"));
      assert.equal((await sh(sandbox, "echo ok")).content, "ok");
    }
    // Memory and CPU need systemd; without it, the agent says so.
    const partial = Sandbox.create({ type: "bwrap", network: false, limits: { memory: 1 << 30, processes: 64 } });
    if ((await partial.spawnSpec("true", project)).file === "prlimit") assert.match(partial.warnings.join(), /memory limit needs systemd-run/);
    sandbox.dispose();
    partial.dispose();
  });
});

describe("sandbox fallbacks", () => {
  test("off means plain bash, still without Smith's own API keys", async () => {
    process.env.AGENT_API_KEY = "sk-agent";
    process.env.SMITH_API_KEY = "sk-smith";
    try {
      const spec = await Sandbox.create({ type: "off", network: false }).spawnSpec("true", "/");
      assert.equal(spec.file, "bash");
      assert.equal(spec.env.AGENT_API_KEY, undefined);
      assert.equal(spec.env.SMITH_API_KEY, undefined);
    } finally {
      delete process.env.AGENT_API_KEY;
      delete process.env.SMITH_API_KEY;
    }
  });

  test("the sandbox is required: without bwrap the agent refuses to start", () => {
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      assert.throws(() => Sandbox.create({ type: "bwrap", network: false }), /bubblewrap.*not installed[\s\S]*dnf install bubblewrap[\s\S]*--sandbox off/);
      assert.equal(Sandbox.create({ type: "off", network: false }).active, false, "only an explicit off runs unsandboxed");
    } finally {
      process.env.PATH = path;
    }
  });
});
