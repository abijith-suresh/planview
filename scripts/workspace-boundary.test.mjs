import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { auditWorkspaceBoundaries } from "./workspace-boundary.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const fixtureWorkspaces = [
  ["packages/core", "@planview/core"],
  ["packages/storage", "@planview/storage"],
  ["packages/daemon", "@planview/daemon"],
  ["packages/local", "@planview/local"],
  ["apps/cli", "@abijith-suresh/planview"],
  ["apps/app", "@planview/app"],
  ["apps/site", "@planview/site"],
];

const makeFixture = () => {
  const root = mkdtempSync(join(tmpdir(), "planview-workspace-boundary-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] })
  );

  for (const [directory, name] of fixtureWorkspaces) {
    const workspace = join(root, directory);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }

  return root;
};

const writeFixtureFile = (root, path, contents) => {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, contents);
};

const withFixture = (run) => {
  const root = makeFixture();
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

test("the repository source and workspace manifests follow the allowed dependency direction", () => {
  assert.deepEqual(auditWorkspaceBoundaries(repositoryRoot), []);
});

test("workspace manifests cannot declare dependencies against the package DAG", () => {
  withFixture((root) => {
    const manifestPath = join(root, "packages/core/package.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        name: "@planview/core",
        dependencies: { "@planview/storage": "workspace:*" },
      })
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, kind, source, target }) => ({
        file,
        kind,
        source,
        target,
      })),
      [
        {
          file: "packages/core/package.json",
          kind: "manifest",
          source: "@planview/core",
          target: "@planview/storage",
        },
      ]
    );
  });
});

test("type, dynamic, require, re-export, relative, and Astro frontmatter imports are checked", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "packages/core/src/dependencies.ts",
      [
        'import type { StorageThing } from "@planview/storage";',
        'export { createStore } from "@planview/storage";',
        'void import("@planview/daemon");',
        'type Daemon = import("@planview/daemon").Daemon;',
        'const daemon = require("@planview/daemon");',
        'import "../../storage/src/index.js";',
        "export type { StorageThing as Alias };",
      ].join("\n")
    );
    writeFixtureFile(
      root,
      "apps/site/src/page.astro",
      '---\nimport { policy } from "@planview/core";\n---\n<p>{policy}</p>\n'
    );
    writeFixtureFile(
      root,
      "packages/core/src/__tests__/ignored.ts",
      'import "@planview/daemon";\n'
    );
    writeFixtureFile(
      root,
      "packages/core/src/_generated/ignored.ts",
      'import "@planview/daemon";\n'
    );
    writeFixtureFile(root, "packages/core/src/ignored.test.ts", 'import "@planview/daemon";\n');

    const violations = auditWorkspaceBoundaries(root);
    assert.deepEqual(
      violations.map(({ file, specifier }) => ({ file, specifier })),
      [
        { file: "apps/site/src/page.astro", specifier: "@planview/core" },
        { file: "packages/core/src/dependencies.ts", specifier: "../../storage/src/index.js" },
        { file: "packages/core/src/dependencies.ts", specifier: "@planview/daemon" },
        { file: "packages/core/src/dependencies.ts", specifier: "@planview/daemon" },
        { file: "packages/core/src/dependencies.ts", specifier: "@planview/daemon" },
        { file: "packages/core/src/dependencies.ts", specifier: "@planview/storage" },
        { file: "packages/core/src/dependencies.ts", specifier: "@planview/storage" },
      ]
    );
  });
});
