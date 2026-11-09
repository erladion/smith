// Builds build/smith-bun: the same app as build/smith, but compiled with Bun
// instead of Node. Bun's runtime needs only glibc (2.17+) at run time, not
// libatomic or libstdc++, so it runs on a stock RHEL 9 without extra packages.
//
// Uses the "baseline" Bun build, which runs on any x86-64 CPU (no AVX2 needed).
// It comes from npm (a dev dependency), so offline builds work from the npm cache.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bun = process.env.BUN || path.join(root, "node_modules/@oven/bun-linux-x64-baseline/bin/bun");
const binary = path.join(root, "build", "smith-bun");

if (!fs.existsSync(bun)) {
  console.error(`Bun not found at ${bun}. Run npm install (on Linux x64), or set BUN to a bun binary.`);
  process.exit(1);
}

// Same version rule as the Node build: SMITH_VERSION (from the release tag), else package.json.
const version = process.env.SMITH_VERSION || JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

fs.mkdirSync(path.dirname(binary), { recursive: true });
execFileSync(
  bun,
  [
    "build",
    "src/cli.ts",
    "--compile",
    // Like curl: trust the system certificate store (Bun uses HTTPS_PROXY etc. by itself).
    "--compile-exec-argv=--use-system-ca",
    // Don't load .env or bunfig.toml from the directory the agent runs in: that is
    // the project, possibly an untrusted repository, and bunfig.toml can preload code.
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--define",
    `__SMITH_VERSION__=${JSON.stringify(version)}`,
    "--outfile",
    binary,
  ],
  { cwd: root, stdio: "inherit" },
);

// Smoke test without Node or Bun on PATH, so we know the binary is self-contained.
const reported = execFileSync(binary, ["--version"], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME } }).trim();
if (reported !== `smith ${version}`) {
  console.error(`The built binary did not start correctly; --version printed:\n${reported}`);
  process.exit(1);
}

const mb = (file) => `${(fs.statSync(file).size / 1024 / 1024).toFixed(0)} MB`;
console.log(`\nBuilt ${path.relative(root, binary)} ${version} (${mb(binary)}, Bun ${execFileSync(bun, ["--version"], { encoding: "utf8" }).trim()}, linux-x64).`);
