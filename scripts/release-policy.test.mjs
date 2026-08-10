import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkReleasePolicy, formatPolicyFailure } from "./release-policy.mjs";

const releasePolicyScript = fileURLToPath(new URL("./release-policy.mjs", import.meta.url));

const withTemporaryRepository = (changesets, callback, version = "0.1.0") => {
  const root = mkdtempSync(join(tmpdir(), "planview-release-policy-"));
  mkdirSync(join(root, "apps", "cli"), { recursive: true });
  mkdirSync(join(root, ".changeset"));
  writeFileSync(
    join(root, "apps", "cli", "package.json"),
    JSON.stringify({ name: "planview", version })
  );
  for (const [file, contents] of Object.entries(changesets)) {
    writeFileSync(join(root, ".changeset", file), contents);
  }

  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("allows a patch bump and ignores Changesets support files and other packages", () => {
  const result = withTemporaryRepository(
    {
      "patch.md": `---\n"planview": patch\n"private-tool": major\n---\n\nPatch the CLI.\n`,
      "README.md": "Changesets documentation, not a pending change.\n",
      "config.json": '{"ignore": []}\n',
    },
    (root) => checkReleasePolicy({ root })
  );

  assert.deepEqual(result.violations, []);
});

test("ignores hidden and uppercase-extension markdown while enforcing valid Changesets", () => {
  const result = withTemporaryRepository(
    {
      ".hidden.md": `---
planview: [minor
---

Ignored hidden markdown.
`,
      "MALFORMED.MD": `---
planview: [major
---

Ignored uppercase-extension markdown.
`,
      "valid-minor.md": `---
planview: minor
---

A valid Changeset.
`,
    },
    (root) => checkReleasePolicy({ root })
  );

  assert.deepEqual(result.violations, [
    { file: "valid-minor.md", packageName: "planview", bump: "minor" },
  ]);
});

test("rejects a minor bump for planview before 1.0.0", () => {
  const result = withTemporaryRepository(
    { "minor.md": `---\n"planview": minor\n---\n\nA feature.\n` },
    (root) => checkReleasePolicy({ root })
  );

  assert.deepEqual(result.violations, [
    { file: "minor.md", packageName: "planview", bump: "minor" },
  ]);
  assert.match(formatPolicyFailure(result), /minor bump for planview/);
  assert.match(formatPolicyFailure(result), /use patch before 1\.0\.0/);
});

test("rejects a major bump for planview before 1.0.0", () => {
  const result = withTemporaryRepository(
    { "major.md": `---\nplanview: major\n---\n\nA breaking change.\n` },
    (root) => checkReleasePolicy({ root })
  );

  assert.deepEqual(result.violations, [
    { file: "major.md", packageName: "planview", bump: "major" },
  ]);
  assert.match(formatPolicyFailure(result), /major bump for planview/);
});

test("uses Changesets parsing for folded and tagged scalar values", () => {
  const result = withTemporaryRepository(
    {
      "folded-patch.md": `---\nplanview: >-\n  patch\n---\n\nA folded patch.\n`,
      "tagged-minor.md": `---\nplanview: !!str minor\n---\n\nA tagged feature.\n`,
    },
    (root) => checkReleasePolicy({ root })
  );

  assert.deepEqual(result.violations, [
    { file: "tagged-minor.md", packageName: "planview", bump: "minor" },
  ]);
});

test("fails closed with a file diagnostic for malformed frontmatter", () => {
  assert.throws(
    () =>
      withTemporaryRepository(
        { "malformed.md": "---\nplanview: [minor\n---\n\nMalformed YAML.\n" },
        (root) => checkReleasePolicy({ root })
      ),
    (error) => {
      assert.match(error.message, /Could not parse \.changeset\/malformed\.md/);
      assert.match(error.message, /invalid YAML in frontmatter/);
      return true;
    }
  );
});

test("fails closed when a changeset has no closing frontmatter delimiter", () => {
  assert.throws(
    () =>
      withTemporaryRepository(
        { "unclosed.md": "---\nplanview: minor\n\nUnclosed frontmatter.\n" },
        (root) => checkReleasePolicy({ root })
      ),
    (error) => {
      assert.match(error.message, /Could not parse \.changeset\/unclosed\.md/);
      assert.match(error.message, /missing or invalid frontmatter/);
      return true;
    }
  );
});

test("enforces the policy for prereleases below 1.0.0 and the 1.0.0 prerelease", () => {
  for (const version of ["0.9.0-beta.1", "1.0.0-beta.1"]) {
    const result = withTemporaryRepository(
      { "minor.md": `---\nplanview: minor\n---\n\nA feature.\n` },
      (root) => checkReleasePolicy({ root }),
      version
    );
    assert.equal(result.enforcePatchOnly, true, `${version} should enforce patch-only releases`);
    assert.equal(result.violations.length, 1, `${version} should reject minor releases`);
  }
});

test("stops enforcing patch-only releases at stable 1.0.0, including build metadata", () => {
  for (const version of ["1.0.0", "1.0.0+build-feature"]) {
    const result = withTemporaryRepository(
      { "minor.md": `---\nplanview: minor\n---\n\nA feature.\n` },
      (root) => checkReleasePolicy({ root }),
      version
    );
    assert.equal(result.enforcePatchOnly, false, `${version} should allow all release types`);
    assert.deepEqual(result.violations, []);
  }
});

test("fails closed for invalid package versions that could bypass the policy", () => {
  for (const version of ["01.0.0", "1.0.0-01", "1.0.0+build..metadata", "1.0.0.0"]) {
    assert.throws(
      () =>
        withTemporaryRepository(
          { "minor.md": `---\nplanview: minor\n---\n\nA feature.\n` },
          (root) => checkReleasePolicy({ root }),
          version
        ),
      (error) => {
        assert.match(error.message, /Package version/);
        assert.match(error.message, /not a valid semantic version/);
        return true;
      },
      version
    );
  }
});

test("handles SemVer prerelease, build, and zero-value edge cases", () => {
  for (const [version, enforcePatchOnly] of [
    ["0.0.0", true],
    ["1.0.0-0", true],
    ["1.0.0-alpha.0+build.7", true],
    ["1.0.0+build.7", false],
  ]) {
    const result = withTemporaryRepository(
      { "minor.md": `---\nplanview: minor\n---\n\nA feature.\n` },
      (root) => checkReleasePolicy({ root }),
      version
    );
    assert.equal(result.enforcePatchOnly, enforcePatchOnly, version);
    assert.equal(result.violations.length, enforcePatchOnly ? 1 : 0, version);
  }
});

test("includes a symlinked markdown candidate like @changesets/read", (t) => {
  const result = withTemporaryRepository({}, (root) => {
    const target = join(root, "target.md");
    const link = join(root, ".changeset", "linked.md");
    writeFileSync(target, `---\nplanview: minor\n---\n\nA feature.\n`);

    try {
      symlinkSync(target, link);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        ["EACCES", "EINVAL", "EPERM", "ENOTSUP"].includes(error.code)
      ) {
        t.skip("symbolic links are not supported in this environment");
        return undefined;
      }
      throw error;
    }

    return checkReleasePolicy({ root });
  });

  if (result === undefined) return;
  assert.deepEqual(result.violations, [
    { file: "linked.md", packageName: "planview", bump: "minor" },
  ]);
});

test("does not silently ignore a matching markdown directory", () => {
  assert.throws(
    () =>
      withTemporaryRepository({}, (root) => {
        mkdirSync(join(root, ".changeset", "directory.md"));
        return checkReleasePolicy({ root });
      }),
    (error) => {
      assert.match(error.message, /Could not read \.changeset\/directory\.md/);
      return true;
    }
  );
});

test("CLI exits nonzero and reports malformed relevant frontmatter", () => {
  const result = withTemporaryRepository(
    { "malformed.md": "---\nplanview: [minor\n---\n\nMalformed YAML.\n" },
    (root) =>
      spawnSync(process.execPath, [releasePolicyScript], {
        cwd: root,
        encoding: "utf8",
      })
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Release policy check failed:/);
  assert.match(result.stderr, /\.changeset\/malformed\.md/);
});
