import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import parseChangesetFile from "@changesets/parse";
import semver from "semver";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPath = "apps/cli/package.json";
const changesetDirectory = ".changeset";
const restrictedBumps = new Set(["minor", "major"]);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const parseVersion = (version) => {
  const normalized = semver.valid(version);
  if (normalized === null) {
    throw new Error(`Package version ${JSON.stringify(version)} is not a valid semantic version.`);
  }

  const parsed = semver.parse(normalized);
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease.length > 0,
  };
};

const parseChangeset = (contents, file) => {
  try {
    const parsed = parseChangesetFile(contents);
    return parsed.releases.map(({ name, type }) => ({ packageName: name, bump: type }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not parse .changeset/${file}: ${message}`, { cause: error });
  }
};

const pendingChangesets = (root) => {
  const directory = resolve(root, changesetDirectory);
  let entries;
  try {
    entries = readdirSync(directory);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error("There is no .changeset directory in this project", { cause: error });
    }
    throw error;
  }

  return entries
    .filter((file) => !file.startsWith(".") && file.endsWith(".md") && !/^README\.md$/i.test(file))
    .flatMap((file) => {
      let contents;
      try {
        contents = readFileSync(resolve(directory, file), "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Could not read .changeset/${file}: ${message}`, { cause: error });
      }

      const changes = parseChangeset(contents, file);
      return changes.map((change) => ({ ...change, file }));
    });
};

export const checkReleasePolicy = ({ root = repositoryRoot } = {}) => {
  const packageJson = readJson(resolve(root, packageJsonPath));
  const version = parseVersion(packageJson.version);
  const changes = pendingChangesets(root);
  const enforcePatchOnly =
    version.major < 1 ||
    (version.major === 1 && version.minor === 0 && version.patch === 0 && version.prerelease);
  const violations = enforcePatchOnly
    ? changes.filter(
        (change) => change.packageName === packageJson.name && restrictedBumps.has(change.bump)
      )
    : [];

  return {
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    enforcePatchOnly,
    violations,
  };
};

export const formatPolicyFailure = ({ packageName, packageVersion, violations }) => {
  const details = violations
    .map(
      ({ file, bump }) =>
        `  - .changeset/${file}: ${bump} bump for ${packageName} (use patch before 1.0.0)`
    )
    .join("\n");

  return [
    `Release policy violation: ${packageName}@${packageVersion} is below 1.0.0.`,
    "Only patch Changesets are allowed for this public package until it reaches 1.0.0.",
    details,
  ].join("\n");
};

const run = ({ root = process.cwd() } = {}) => {
  const result = checkReleasePolicy({ root });
  if (result.violations.length > 0) {
    process.stderr.write(`${formatPolicyFailure(result)}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(
    result.enforcePatchOnly
      ? `Release policy passed: ${result.packageName}@${result.packageVersion} has no pending minor or major bump.\n`
      : `Release policy skipped: ${result.packageName}@${result.packageVersion} is at least 1.0.0.\n`
  );
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`Release policy check failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
