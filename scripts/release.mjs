import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const inheritedEnvironment = { ...process.env };
const withoutCredentials = (environment) => {
  const sanitized = { ...environment };
  for (const name of [
    "RELEASE_TOKEN",
    "GITHUB_TOKEN",
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_URL",
  ]) {
    delete sanitized[name];
  }
  return sanitized;
};

const runCommand = (command, args, environment) => {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: environment,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} exited with status ${result.status ?? 1}.`);
  }
};

const isolatedHome = mkdtempSync(join(tmpdir(), "planview-release-home-"));
const safeEnvironment = {
  ...withoutCredentials(inheritedEnvironment),
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  NPM_CONFIG_USERCONFIG: join(isolatedHome, ".npmrc"),
};

try {
  for (const args of [
    ["run", "release-policy"],
    ["run", "verify"],
    ["run", "pack:check"],
    ["run", "pack:verified"],
  ]) {
    runCommand(npm, args, safeEnvironment);
  }

  const publishEnvironment = { ...inheritedEnvironment };
  delete publishEnvironment.RELEASE_TOKEN;
  delete publishEnvironment.GITHUB_TOKEN;
  delete publishEnvironment.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  delete publishEnvironment.ACTIONS_ID_TOKEN_REQUEST_URL;
  runCommand(process.execPath, ["scripts/publish-verified.mjs"], publishEnvironment);
} finally {
  rmSync(isolatedHome, { recursive: true, force: true });
}
