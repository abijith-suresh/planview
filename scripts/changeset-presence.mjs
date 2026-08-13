import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import parseChangesetFile from "@changesets/parse";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const publicPackagePath = "apps/cli/package.json";
const changesetPathPattern = /^\.changeset\/(?!README\.md$)[^/]+\.md$/i;
const excludedCliPaths = ["apps/cli/CHANGELOG.md", "apps/cli/dist/", "apps/cli/test/"];

const readJson = (root, path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

const isReleasableCliPath = (path) => {
  const normalized = path.replaceAll("\\", "/");
  if (
    excludedCliPaths.some((excluded) => normalized === excluded || normalized.startsWith(excluded))
  ) {
    return false;
  }
  if (normalized.startsWith("apps/cli/")) {
    return true;
  }
  return ["packages/core/", "packages/daemon/", "packages/storage/"].some(
    (prefix) =>
      normalized.startsWith(prefix) &&
      !normalized.includes("/test/") &&
      !normalized.endsWith("/README.md")
  );
};

const readChangedFiles = ({ root, baseSha, headSha }) => {
  const range =
    baseSha === undefined || headSha === undefined
      ? ["HEAD^", "HEAD"]
      : [`${baseSha}...${headSha}`];
  const result = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMR", ...range], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || "Could not determine the changed files for this PR.");
  }
  return result.stdout
    .split("\n")
    .map((file) => file.trim())
    .filter(Boolean);
};

const parseChangedChangeset = (root, file) => {
  let parsed;
  try {
    parsed = parseChangesetFile(readFileSync(resolve(root, file), "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse ${file}: ${message}`, { cause: error });
  }
  return parsed.releases.map(({ name, type }) => ({ file, packageName: name, bump: type }));
};

export const checkChangesetPresence = ({
  root = repositoryRoot,
  changedFiles,
  baseSha,
  headSha,
} = {}) => {
  const files = changedFiles ?? readChangedFiles({ root, baseSha, headSha });
  const packageName = readJson(root, publicPackagePath).name;
  const releasableFiles = files.filter(isReleasableCliPath);
  const changedChangesets = files
    .filter((file) => changesetPathPattern.test(file))
    .flatMap((file) => parseChangedChangeset(root, file));
  const publicPatchChangesets = changedChangesets.filter(
    (change) => change.packageName === packageName && change.bump === "patch"
  );

  return {
    packageName,
    required: releasableFiles.length > 0,
    releasableFiles,
    changedChangesets,
    publicPatchChangesets,
  };
};

const run = ({ root = process.cwd() } = {}) => {
  const result = checkChangesetPresence({
    root,
    baseSha: process.env.BASE_SHA ?? process.env.GITHUB_BASE_SHA,
    headSha: process.env.HEAD_SHA ?? process.env.GITHUB_HEAD_SHA,
  });
  if (!result.required) {
    process.stdout.write("Changeset presence check passed: no releasable CLI paths changed.\n");
    return;
  }
  if (result.publicPatchChangesets.length === 0) {
    process.stderr.write(
      `${[
        `Changeset presence check failed: releasable CLI paths changed (${result.releasableFiles.join(", ")}).`,
        `Add a Changeset for ${result.packageName} with a patch bump.`,
      ].join("\n")}\n`
    );
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Changeset presence check passed: ${result.packageName} has a patch Changeset for the releasable CLI changes.\n`
  );
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Changeset presence check failed closed: ${message}\n`);
    process.exitCode = 1;
  }
}
