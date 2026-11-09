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
  Sandbox.create("on", false);
} catch {
  available = false;
}

describe("bash in the sandbox", { skip: !available && "bwrap is not available" }, () => {
  let home: string;
  let project: string;
  let outside: string;
  const originalHome = process.env.HOME;

  const run = (command: string, opts: { network?: boolean; cwd?: string; timeout_ms?: number } = {}) => {
    const sandbox = Sandbox.create("on", opts.network ?? false);
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
    const sandbox = Sandbox.create("on", false);
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
    const sandbox = Sandbox.create("on", false);
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

  test("a timed-out command is killed with everything it started", async () => {
    const started = Date.now();
    const res = await run("sleep 30 & sleep 30", { timeout_ms: 300 });
    assert.equal(res.isError, true);
    assert.match(res.content, /timed out/);
    assert.ok(Date.now() - started < 5_000);
  });
});

describe("sandbox fallbacks", () => {
  test("off means plain bash, still without the agent's own API keys", () => {
    process.env.AGENT_API_KEY = "sk-agent";
    try {
      const spec = Sandbox.create("off", false).spawnSpec("true", "/");
      assert.equal(spec.file, "bash");
      assert.equal(spec.env.AGENT_API_KEY, undefined);
    } finally {
      delete process.env.AGENT_API_KEY;
    }
  });

  test("the sandbox is required: without bwrap the agent refuses to start", () => {
    const path = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      assert.throws(() => Sandbox.create("on", false), /bubblewrap.*not installed[\s\S]*dnf install bubblewrap[\s\S]*--sandbox off/);
      assert.equal(Sandbox.create("off", false).active, false, "only an explicit off runs unsandboxed");
    } finally {
      process.env.PATH = path;
    }
  });
});
