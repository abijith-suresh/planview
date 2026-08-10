import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const cli = resolve(packageRoot, "dist/index.js");
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"));

const execute = (...args) =>
  spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });

test("--help and -h produce the same deterministic output", () => {
  const long = execute("--help");
  const short = execute("-h");

  assert.equal(long.status, 0);
  assert.equal(long.error, undefined);
  assert.equal(long.stderr, "");
  assert.equal(long.stdout, short.stdout);
  assert.match(long.stdout, /^Usage: planview \[options\]/);
});

test("--version and -v produce the package version", () => {
  const long = execute("--version");
  const short = execute("-v");

  assert.equal(long.status, 0);
  assert.equal(long.error, undefined);
  assert.equal(long.stderr, "");
  assert.equal(long.stdout, `planview ${packageJson.version}\n`);
  assert.equal(short.stdout, long.stdout);
});

test("unknown options fail with a useful error", () => {
  const result = execute("--unknown");

  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Unknown option: --unknown\n/);
  assert.match(result.stderr, /Usage: planview \[options\]/);
});

test("recognized options reject trailing arguments", () => {
  const result = execute("--help", "unexpected");

  assert.equal(result.status, 1);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^Unexpected argument: unexpected\n/);
});

test("the installed bin invokes the built CLI", () => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(
    npm,
    ["exec", "--workspace", "planview", "--", "planview", "--version"],
    { cwd: repositoryRoot, encoding: "utf8" }
  );

  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, `planview ${packageJson.version}\n`);
  assert.equal(result.stderr, "");
});

test("importing the entrypoint does not execute the command", () => {
  const moduleUrl = pathToFileURL(cli).href;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)});`],
    { encoding: "utf8" }
  );

  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("a clean build is included by the package dry run", () => {
  rmSync(resolve(packageRoot, "dist"), { force: true, recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npm, ["pack", "--dry-run", "--json"], {
    cwd: packageRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  assert.equal(result.error, undefined);
  assert.match(result.stdout, /"path": "dist\/index\.js"/);
  assert.match(result.stdout, /"path": "dist\/index\.d\.ts"/);
});
