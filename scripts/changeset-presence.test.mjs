import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkChangesetPresence } from "./changeset-presence.mjs";

const withRepository = (_changedFiles, changesets, callback) => {
  const root = mkdtempSync(join(tmpdir(), "planview-changeset-presence-"));
  mkdirSync(join(root, "apps", "cli"), { recursive: true });
  mkdirSync(join(root, ".changeset"));
  writeFileSync(
    join(root, "apps", "cli", "package.json"),
    JSON.stringify({ name: "@abijith-suresh/planview", version: "0.1.0" })
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

const patchChangeset = `---\n"@abijith-suresh/planview": patch\n---\n\nA CLI change.\n`;

test("requires a scoped public patch Changeset for releasable CLI source", () => {
  const result = withRepository(
    ["apps/cli/src/index.ts", ".changeset/patch.md"],
    { "patch.md": patchChangeset },
    (root) =>
      checkChangesetPresence({
        root,
        changedFiles: ["apps/cli/src/index.ts", ".changeset/patch.md"],
      })
  );
  assert.equal(result.required, true);
  assert.equal(result.publicPatchChangesets.length, 1);
});

test("does not let a private or non-patch Changeset satisfy the CLI requirement", () => {
  const result = withRepository(
    ["packages/daemon/src/index.ts", ".changeset/minor.md"],
    {
      "minor.md": `---\n"@abijith-suresh/planview": minor\n---\n\nA feature.\n`,
    },
    (root) =>
      checkChangesetPresence({
        root,
        changedFiles: ["packages/daemon/src/index.ts", ".changeset/minor.md"],
      })
  );
  assert.equal(result.required, true);
  assert.deepEqual(result.publicPatchChangesets, []);
});

test("ignores tests, site changes, and Changesets support files", () => {
  for (const changedFiles of [
    ["apps/cli/test/cli.test.mjs"],
    ["apps/site/src/pages/index.astro"],
    [".changeset/README.md"],
  ]) {
    const result = withRepository(changedFiles, {}, (root) =>
      checkChangesetPresence({ root, changedFiles })
    );
    assert.equal(result.required, false, changedFiles.join(", "));
  }
});

test("fails closed for malformed changed Changesets", () => {
  assert.throws(
    () =>
      withRepository(
        ["apps/cli/src/index.ts", ".changeset/broken.md"],
        { "broken.md": "---\n@abijith-suresh/planview: [patch\n---\n" },
        (root) =>
          checkChangesetPresence({
            root,
            changedFiles: ["apps/cli/src/index.ts", ".changeset/broken.md"],
          })
      ),
    /Could not parse \.changeset\/broken\.md/
  );
});
