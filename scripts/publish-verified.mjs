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
const tarballName = `${packageName.replace(/^@/, "").replace("/", "-")}-${packageVersion}.tgz`;
const tarball = resolve(repositoryRoot, process.argv[2] ?? tarballName);
const publishMode = process.env.PLANVIEW_NPM_PUBLISH ?? "disabled";
const registry = process.env.PLANVIEW_NPM_REGISTRY?.trim() ?? "";

if (packageName !== "@abijith-suresh/planview" || typeof packageVersion !== "string") {
  throw new Error("The verified package metadata is invalid.");
}
if (!existsSync(tarball) || !statSync(tarball).isFile()) {
  throw new Error(`The verified package tarball does not exist: ${tarball}`);
}
if (!["disabled", "dry-run", "enabled"].includes(publishMode)) {
  throw new Error('PLANVIEW_NPM_PUBLISH must be "disabled", "dry-run", or "enabled".');
}

if (publishMode === "disabled") {
  process.stdout.write(
    `npm publishing is explicitly disabled; verified ${packageName}@${packageVersion} was not published.\n`
  );
  process.exit(0);
}

if (registry !== "") {
  let parsedRegistry;
  try {
    parsedRegistry = new URL(registry);
  } catch (error) {
    throw new Error(`PLANVIEW_NPM_REGISTRY is not a valid URL: ${registry}`, { cause: error });
  }
  if (parsedRegistry.protocol !== "https:" || parsedRegistry.username || parsedRegistry.password) {
    throw new Error("PLANVIEW_NPM_REGISTRY must be an HTTPS URL without embedded credentials.");
  }
}
if (publishMode === "enabled" && registry === "") {
  throw new Error("Publishing is disabled until PLANVIEW_NPM_REGISTRY is explicitly configured.");
}
if (publishMode === "enabled" && !process.env.NPM_TOKEN && !process.env.NODE_AUTH_TOKEN) {
  throw new Error("Publishing is disabled until NPM_TOKEN or NODE_AUTH_TOKEN is configured.");
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const environment = { ...process.env };
if (environment.NODE_AUTH_TOKEN === undefined && environment.NPM_TOKEN !== undefined) {
  environment.NODE_AUTH_TOKEN = environment.NPM_TOKEN;
}
delete environment.NPM_TOKEN;
delete environment.RELEASE_TOKEN;
delete environment.GITHUB_TOKEN;
delete environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
delete environment.ACTIONS_ID_TOKEN_REQUEST_URL;
const args = ["publish", tarball, "--ignore-scripts", "--access", "public"];
if (registry !== "") {
  args.push("--registry", registry);
}
if (publishMode === "dry-run") {
  args.push("--dry-run");
}
const result = spawnSync(npm, args, {
  cwd: repositoryRoot,
  env: environment,
  stdio: "inherit",
});

if (result.error !== undefined) {
  throw result.error;
}
if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else if (publishMode === "enabled") {
  process.stdout.write(`New tag: ${packageName}@${packageVersion}\n`);
}
