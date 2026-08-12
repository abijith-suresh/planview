import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  readFileSync(resolve(repositoryRoot, "apps/cli/package.json"), "utf8")
);
const packageVersion = packageJson.version;
const packageName = packageJson.name;
const tarball = resolve(repositoryRoot, process.argv[2] ?? `${packageName}-${packageVersion}.tgz`);

if (packageName !== "planview" || typeof packageVersion !== "string") {
  throw new Error("The verified package metadata is invalid.");
}
if (!existsSync(tarball) || !statSync(tarball).isFile()) {
  throw new Error(`The verified package tarball does not exist: ${tarball}`);
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = { ...process.env };
delete environment.RELEASE_TOKEN;
const result = spawnSync(npm, ["publish", tarball, "--ignore-scripts", "--access", "public"], {
  cwd: repositoryRoot,
  env: environment,
  stdio: "inherit",
});

if (result.error !== undefined) {
  throw result.error;
}
process.exitCode = result.status ?? 1;
