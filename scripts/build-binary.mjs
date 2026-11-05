// Builds build/agent: one executable containing Node.js and the bundled app,
// so the target machine needs neither Node nor node_modules.
//
//   1. esbuild bundles src/ and all npm dependencies into build/agent.mjs.
//   2. `node --build-sea` embeds that file into a copy of the running Node.
//   3. The result is smoke-tested with Node removed from PATH.
//
// The binary is for the OS and CPU you build on (e.g. Linux x64).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, "build");
const bundle = path.join(out, "agent.mjs");
const binary = path.join(out, "agent");
const seaConfig = path.join(out, "sea.json");

const nodeHelp = execFileSync(process.execPath, ["--help"], { encoding: "utf8" });
if (!nodeHelp.includes("--build-sea")) {
  console.error(`Building the binary needs a Node.js with --build-sea (26 or newer); this is ${process.version}.`);
  console.error("Only the build machine needs it: the binary itself carries its own Node.");
  process.exit(1);
}

// The version baked into the binary: AGENT_VERSION (set by the release workflow
// from the git tag), else package.json's.
const version = process.env.AGENT_VERSION || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, "src/cli.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  define: { __AGENT_VERSION__: JSON.stringify(version) },
  logLevel: "warning",
});

fs.writeFileSync(
  seaConfig,
  JSON.stringify({ main: bundle, mainFormat: "module", output: binary, disableExperimentalSEAWarning: true }, null, 2),
);
execFileSync(process.execPath, ["--build-sea", seaConfig], { stdio: "inherit" });

// Smoke test without Node on PATH, so we know the binary is self-contained.
const reported = execFileSync(binary, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } }).trim();
if (reported !== `agent ${version}`) {
  console.error(`The built binary did not start correctly; --version printed:\n${reported}`);
  process.exit(1);
}

const mb = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(0)} MB`;
console.log(`\nBuilt ${path.relative(root, binary)} ${version} (${mb(binary)}, Node ${process.version}, ${process.platform}-${process.arch}).`);
console.log("Copy it anywhere and run it; nothing else is needed except bubblewrap for the sandbox.");
