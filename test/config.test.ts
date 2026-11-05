import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { loadConfig } from "../src/core/config.js";
import { Server } from "../src/core/server.js";
import { type FakeServer, startFakeServer } from "./fake-server.js";

let dir: string;
const write = (name: string, content: unknown, mode = 0o600) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), { mode });
  fs.chmodSync(file, mode);
  return file;
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-config-"));
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("config file", () => {
  test("a missing file means no endpoints", () => {
    const config = loadConfig(path.join(dir, "nope.json"));
    assert.deepEqual(config.endpoints, []);
  });

  test("loads endpoints and resolves apiKeyEnv", () => {
    process.env.TEST_GPU_KEY = "sk-from-env";
    try {
      const file = write("ok.json", {
        default: "gpu",
        endpoints: {
          local: { baseURL: "http://localhost:8080/v1" },
          gpu: { baseURL: "http://10.0.0.5:8000/v1", apiKeyEnv: "TEST_GPU_KEY", model: "qwen", contextSize: 65536 },
          missing: { baseURL: "http://x/v1", apiKeyEnv: "TEST_UNSET_KEY" },
        },
      });
      const config = loadConfig(file);
      assert.equal(config.defaultEndpoint, "gpu");
      assert.deepEqual(config.endpoints[1], {
        name: "gpu",
        baseURL: "http://10.0.0.5:8000/v1",
        apiKey: "sk-from-env",
        model: "qwen",
        contextSize: 65536,
      });
      assert.match(config.warnings.join("\n"), /TEST_UNSET_KEY is not set/);
    } finally {
      delete process.env.TEST_GPU_KEY;
    }
  });

  test("maxSteps is read and checked", () => {
    assert.equal(loadConfig(write("steps.json", { maxSteps: 120 })).maxSteps, 120);
    assert.equal(loadConfig(write("nosteps.json", {})).maxSteps, undefined);
    assert.throws(() => loadConfig(write("badsteps.json", { maxSteps: 0 })), /Invalid[\s\S]*maxSteps/);
    assert.throws(() => loadConfig(write("strsteps.json", { maxSteps: "50" })), /Invalid[\s\S]*maxSteps/);
  });

  test("rejects invalid files with a useful message", () => {
    assert.throws(() => loadConfig(write("bad.json", "{ nope")), /not valid JSON/);
    assert.throws(() => loadConfig(write("url.json", { endpoints: { a: { baseURL: "not a url" } } })), /Invalid[\s\S]*baseURL/);
    assert.throws(() => loadConfig(write("typo.json", { endpoints: { a: { baseURL: "http://x/v1", modle: "m" } } })), /modle/);
    assert.throws(() => loadConfig(write("default.json", { default: "b", endpoints: { a: { baseURL: "http://x/v1" } } })), /"b" is not defined/);
    assert.throws(
      () => loadConfig(write("both.json", { endpoints: { a: { baseURL: "http://x/v1", apiKey: "k", apiKeyEnv: "K" } } })),
      /not both/,
    );
  });

  test("warns when a file with API keys is readable by others", () => {
    const file = write("open.json", { endpoints: { a: { baseURL: "http://x/v1", apiKey: "sk" } } }, 0o644);
    assert.match(loadConfig(file).warnings.join("\n"), /chmod 600/);
    fs.chmodSync(file, 0o600);
    assert.deepEqual(loadConfig(file).warnings, []);
  });
});

describe("choosing a model", () => {
  let fake: FakeServer;
  before(async () => {
    fake = await startFakeServer();
  });
  after(() => fake.close());

  const endpoint = (model?: string) => Server.fromEndpoint({ name: "t", baseURL: fake.baseURL, model });

  test("prefers the remembered model, then the configured one, then the first listed", async () => {
    fake.models = ["a", "b", "c"];
    assert.equal(await endpoint("c").chooseModel(["b"]), "b");
    assert.equal(await endpoint("c").chooseModel(["gone"]), "c");
    assert.equal(await endpoint().chooseModel([undefined]), "a");
  });

  test("uses the configured model when the server can't list models", async () => {
    fake.models = null;
    assert.equal(await endpoint("m").chooseModel([]), "m");
    await assert.rejects(endpoint().chooseModel([]), /Could not list models/);
  });

  test("a configured context size wins over detection", async () => {
    const server = Server.fromEndpoint({ name: "t", baseURL: fake.baseURL, contextSize: 1234 });
    assert.equal(await server.contextSize("anything"), 1234);
  });
});
