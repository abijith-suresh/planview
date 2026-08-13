import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const publicPackageName = "@abijith-suresh/planview";

const copyRepository = () => {
  const root = mkdtempSync(join(tmpdir(), "planview-version-packages-"));
  const ignoredDirectories = new Set([".git", "node_modules", "dist"]);

  cpSync(repositoryRoot, root, {
    recursive: true,
    filter: (source) => {
      const path = relative(repositoryRoot, source);
      return (
        !path.split(sep).some((part) => ignoredDirectories.has(part)) && !path.endsWith(".tgz")
      );
    },
  });
  symlinkSync(
    resolve(repositoryRoot, "node_modules"),
    join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir"
  );

  const changesetDirectory = join(root, ".changeset");
  for (const file of readdirSync(changesetDirectory)) {
    if (file.endsWith(".md") && file !== "README.md") {
      rmSync(join(changesetDirectory, file));
    }
  }
  writeFileSync(
    join(changesetDirectory, "release.md"),
    `---\n"${publicPackageName}": patch\n---\n\nVersion the scoped public package.\n`
  );

  return root;
};

const withRepositoryCopy = (callback) => {
  const root = copyRepository();
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("version-packages updates the scoped package lock without running lifecycle scripts", () => {
  withRepositoryCopy((root) => {
    const packagePath = join(root, "apps", "cli", "package.json");
    const rootPackagePath = join(root, "package.json");
    const lifecycleMarker = join(root, "lifecycle-ran");
    const packageBefore = JSON.parse(readFileSync(packagePath, "utf8"));
    const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));

    writeFileSync(
      join(root, "scripts", "lifecycle-marker.mjs"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(lifecycleMarker)}, "ran");\n`
    );
    rootPackage.scripts.preinstall = "node scripts/lifecycle-marker.mjs";
    writeFileSync(rootPackagePath, `${JSON.stringify(rootPackage, null, 2)}\n`);

    const result = spawnSync(npm, ["run", "version-packages"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_audit: "false", npm_config_fund: "false" },
    });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(existsSync(lifecycleMarker), false, "the preinstall lifecycle must not run");

    const packageAfter = JSON.parse(readFileSync(packagePath, "utf8"));
    const lockfile = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
    const lockPackage = lockfile.packages["apps/cli"];

    assert.equal(packageAfter.name, publicPackageName);
    assert.notEqual(packageAfter.version, packageBefore.version);
    assert.equal(lockPackage.name, packageAfter.name);
    assert.equal(lockPackage.version, packageAfter.version);
    assert.deepEqual(lockfile.packages[`node_modules/${publicPackageName}`], {
      resolved: "apps/cli",
      link: true,
    });
    assert.equal(
      lockfile.packages["node_modules/planview"],
      undefined,
      "the lockfile must not introduce an unscoped public package"
    );
  });
});
