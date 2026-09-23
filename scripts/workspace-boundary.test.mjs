import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, win32 } from "node:path";
import { platform, tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditWorkspaceBoundaries,
  isWithinPath,
  readDirectoryEntries,
} from "./workspace-boundary.mjs";

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

const populateFixture = (
  root,
  { patterns = ["apps/*", "packages/*"], nestedCore = false } = {}
) => {
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ private: true, workspaces: patterns })
  );

  for (const [directory, name] of fixtureWorkspaces) {
    const workspaceDirectory =
      nestedCore && directory === "packages/core" ? "packages/nested/core" : directory;
    const workspace = join(root, workspaceDirectory);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
  }

  return root;
};

const makeFixture = (options = {}) => {
  const root = mkdtempSync(join(tmpdir(), "planview-workspace-boundary-"));
  return populateFixture(root, options);
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

test("source exclusions are relative to the workspace even when the checkout path contains test", () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "planview-workspace-boundary-test-path-"));
  const root = join(temporaryRoot, "test", "checkout");
  try {
    populateFixture(root);
    writeFixtureFile(root, "packages/core/src/dependencies.ts", 'import "@planview/daemon";\n');

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target }) => ({ file, target })),
      [{ file: "packages/core/src/dependencies.ts", target: "@planview/daemon" }]
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("directory traversal ignores only missing-path errors", () => {
  const errorWithCode = (code) => Object.assign(new Error(code), { code });
  assert.deepEqual(
    readDirectoryEntries("missing", () => {
      throw errorWithCode("ENOENT");
    }),
    []
  );
  assert.deepEqual(
    readDirectoryEntries("not-a-directory", () => {
      throw errorWithCode("ENOTDIR");
    }),
    []
  );

  for (const code of ["EACCES", "EIO"]) {
    assert.throws(
      () =>
        readDirectoryEntries("unreadable", () => {
          throw errorWithCode(code);
        }),
      (error) => error.code === code
    );
  }
});

test("path containment rejects Windows paths on different drives or UNC roots", () => {
  const win32PathApi = {
    relative: win32.relative,
    isAbsolute: win32.isAbsolute,
    sep: win32.sep,
  };

  assert.equal(isWithinPath("C:\\repo\\packages", "C:\\repo", win32PathApi), true);
  assert.equal(isWithinPath("D:\\repo\\packages", "C:\\repo", win32PathApi), false);
  assert.equal(isWithinPath("\\\\other-server\\share\\repo", "C:\\repo", win32PathApi), false);
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

test("globstar workspace patterns discover nested workspaces and their violations", () => {
  const root = makeFixture({ patterns: ["apps/*", "packages/**"], nestedCore: true });
  try {
    const manifestPath = join(root, "packages/nested/core/package.json");
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
          file: "packages/nested/core/package.json",
          kind: "manifest",
          source: "@planview/core",
          target: "@planview/storage",
        },
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("literal workspace patterns reject symlinks instead of following them", {
  skip: platform === "win32",
}, () => {
  const root = makeFixture({ patterns: ["apps/*", "packages/*", "packages/escaped"] });
  const outside = mkdtempSync(join(tmpdir(), "planview-outside-workspace-"));
  try {
    writeFileSync(
      join(outside, "package.json"),
      JSON.stringify({ name: "@planview/external", version: "1.0.0" })
    );
    symlinkSync(outside, join(root, "packages/escaped"), "dir");
    assert.throws(() => auditWorkspaceBoundaries(root), /resolved to a symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("unsupported workspace patterns and missing required workspaces fail closed", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/{app,site}", "packages/*"] })
    );
    assert.throws(() => auditWorkspaceBoundaries(root), /Unsupported npm workspace pattern/);
  });

  withFixture((root) => {
    rmSync(join(root, "packages/core"), { recursive: true, force: true });
    assert.throws(
      () => auditWorkspaceBoundaries(root),
      /did not find required workspace.*@planview\/core/
    );
  });
});

test("malformed workspace manifests fail closed", () => {
  withFixture((root) => {
    writeFileSync(join(root, "packages/core/package.json"), "{\n");
    assert.throws(() => auditWorkspaceBoundaries(root), SyntaxError);
  });
});

test("root and workspace package manifest symlinks are rejected", {
  skip: platform === "win32",
}, () => {
  const root = makeFixture();
  const outside = mkdtempSync(join(tmpdir(), "planview-outside-manifest-"));
  try {
    const rootManifestOutside = join(outside, "root-package.json");
    writeFileSync(
      rootManifestOutside,
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] })
    );
    rmSync(join(root, "package.json"));
    symlinkSync(rootManifestOutside, join(root, "package.json"), "file");
    assert.throws(
      () => auditWorkspaceBoundaries(root),
      /Package manifest symlinks are unsupported/
    );

    rmSync(join(root, "package.json"));
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ private: true, workspaces: ["apps/*", "packages/*"] })
    );
    const workspaceManifestOutside = join(outside, "core-package.json");
    writeFileSync(
      workspaceManifestOutside,
      JSON.stringify({ name: "@planview/core", version: "1.0.0" })
    );
    rmSync(join(root, "packages/core/package.json"));
    symlinkSync(workspaceManifestOutside, join(root, "packages/core/package.json"), "file");
    assert.throws(
      () => auditWorkspaceBoundaries(root),
      /Package manifest symlinks are unsupported/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("type, dynamic, require, module.require, re-export, relative, and Astro frontmatter imports are checked", () => {
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
    writeFixtureFile(
      root,
      "packages/core/src/ignored.generated.ts",
      'import "@planview/daemon";\n'
    );
    writeFixtureFile(root, "packages/core/test/ignored.ts", 'import "@planview/daemon";\n');
    writeFixtureFile(root, "packages/core/dist/ignored.ts", 'import "@planview/daemon";\n');
    writeFixtureFile(root, "packages/core/build/ignored.ts", 'import "@planview/daemon";\n');
    writeFixtureFile(
      root,
      "packages/core/node_modules/fake/ignored.ts",
      'import "@planview/daemon";\n'
    );
    writeFixtureFile(root, "packages/core/.astro/ignored.ts", 'import "@planview/daemon";\n');
    writeFixtureFile(root, "packages/core/.output/ignored.ts", 'import "@planview/daemon";\n');
    writeFixtureFile(root, "packages/core/coverage/ignored.ts", 'import "@planview/daemon";\n');
    writeFixtureFile(
      root,
      "packages/core/src/module-require.cjs",
      'module.require("@planview/daemon");\n'
    );

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
        { file: "packages/core/src/module-require.cjs", specifier: "@planview/daemon" },
      ]
    );
  });
});

test("nonliteral import and require calls fail closed with source locations", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/app/src/nonliteral.mjs",
      [
        "const moduleName = getModuleName();",
        "import(moduleName);",
        "require(moduleName);",
        "module.require(moduleName);",
        "import('@planview/' + moduleName);",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, kind, message }) => ({ file, kind, message })),
      [2, 3, 4, 5].map((line) => ({
        file: "apps/app/src/nonliteral.mjs",
        kind: "unresolved-import",
        message: `apps/app/src/nonliteral.mjs:${line}:1: module call must use a statically resolvable string literal`,
      }))
    );
  });
});

test("nonliteral module diagnostics in Astro scripts use source-file line numbers", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/site/src/nonliteral.astro",
      [
        "---",
        "const moduleName = getModuleName();",
        "import(moduleName);",
        "---",
        "<script>",
        "import(moduleName);",
        "</script>",
        "<script>import(moduleName);</script>",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, kind, message }) => ({
        file,
        kind,
        message,
      })),
      [
        {
          file: "apps/site/src/nonliteral.astro",
          kind: "unresolved-import",
          message:
            "apps/site/src/nonliteral.astro:3:1: module call must use a statically resolvable string literal",
        },
        {
          file: "apps/site/src/nonliteral.astro",
          kind: "unresolved-import",
          message:
            "apps/site/src/nonliteral.astro:6:1: module call must use a statically resolvable string literal",
        },
        {
          file: "apps/site/src/nonliteral.astro",
          kind: "unresolved-import",
          message:
            "apps/site/src/nonliteral.astro:8:9: module call must use a statically resolvable string literal",
        },
      ]
    );
  });
});

test("npm and local path aliases preserve manifest and source dependency direction", () => {
  withFixture((root) => {
    const appManifest = join(root, "apps/app/package.json");
    writeFileSync(
      appManifest,
      JSON.stringify({
        name: "@planview/app",
        dependencies: {
          "daemon-alias": "npm:@planview/daemon@1.2.3",
          "daemon-file": "file:../../packages/daemon",
          "storage-link": "link:../../packages/storage",
        },
      })
    );
    writeFixtureFile(
      root,
      "apps/app/src/aliases.ts",
      ['import "daemon-alias/client";', 'import "daemon-file";', 'import "storage-link";'].join(
        "\n"
      )
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, kind, target, specifier }) => ({
        file,
        kind,
        target,
        specifier,
      })),
      [
        {
          file: "apps/app/package.json",
          kind: "manifest",
          target: "@planview/daemon",
          specifier: "dependencies.daemon-alias",
        },
        {
          file: "apps/app/package.json",
          kind: "manifest",
          target: "@planview/daemon",
          specifier: "dependencies.daemon-file",
        },
        {
          file: "apps/app/package.json",
          kind: "manifest",
          target: "@planview/storage",
          specifier: "dependencies.storage-link",
        },
        {
          file: "apps/app/src/aliases.ts",
          kind: "import",
          target: "@planview/daemon",
          specifier: "daemon-alias/client",
        },
        {
          file: "apps/app/src/aliases.ts",
          kind: "import",
          target: "@planview/daemon",
          specifier: "daemon-file",
        },
        {
          file: "apps/app/src/aliases.ts",
          kind: "import",
          target: "@planview/storage",
          specifier: "storage-link",
        },
      ]
    );
  });
});

test("unresolved workspace aliases fail closed", () => {
  withFixture((root) => {
    writeFileSync(
      join(root, "apps/app/package.json"),
      JSON.stringify({
        name: "@planview/app",
        dependencies: { "daemon-alias": "workspace:*" },
      })
    );
    assert.throws(
      () => auditWorkspaceBoundaries(root),
      /Cannot safely resolve workspace protocol alias/
    );
  });
});

test("workspace-root configs, scripts, and Astro inline scripts are scanned", () => {
  withFixture((root) => {
    writeFixtureFile(root, "apps/app/vite.config.ts", 'import "@planview/core";\n');
    writeFixtureFile(root, "apps/site/astro.config.ts", 'import "@planview/daemon";\n');
    writeFixtureFile(root, "apps/site/server.mjs", 'require("@planview/storage");\n');
    writeFixtureFile(root, "apps/site/.storybook/main.ts", 'import "@planview/daemon";\n');
    writeFixtureFile(
      root,
      "apps/site/src/inline-script.astro",
      '<script>\nimport "@planview/core";\n</script>\n'
    );

    const actual = auditWorkspaceBoundaries(root).map(({ file, specifier }) => ({
      file,
      specifier,
    }));
    const expected = [
      { file: "apps/app/vite.config.ts", specifier: "@planview/core" },
      { file: "apps/site/astro.config.ts", specifier: "@planview/daemon" },
      { file: "apps/site/server.mjs", specifier: "@planview/storage" },
      { file: "apps/site/src/inline-script.astro", specifier: "@planview/core" },
      { file: "apps/site/.storybook/main.ts", specifier: "@planview/daemon" },
    ].sort(
      (left, right) =>
        left.file.localeCompare(right.file) || left.specifier.localeCompare(right.specifier)
    );
    assert.deepEqual(actual, expected);
  });
});

test("TypeScript paths aliases are resolved to their target workspace", () => {
  withFixture((root) => {
    writeFixtureFile(root, "packages/daemon/src/entry.ts", "export const entry = true;\n");
    writeFixtureFile(
      root,
      "apps/app/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@internal-daemon/*": ["../../packages/daemon/src/*"] },
        },
      })
    );
    writeFixtureFile(root, "apps/app/src/alias.ts", 'import "@internal-daemon/entry";\n');

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "apps/app/src/alias.ts",
          target: "@planview/daemon",
          specifier: "@internal-daemon/entry",
        },
      ]
    );
  });
});

test("relative imports through a symlink are classified by their resolved workspace", {
  skip: platform === "win32",
}, () => {
  withFixture((root) => {
    writeFixtureFile(root, "packages/daemon/src/target.js", "export const target = true;\n");
    const symlinkPath = join(root, "apps/app/src/daemon");
    mkdirSync(dirname(symlinkPath), { recursive: true });
    symlinkSync(join(root, "packages/daemon/src"), symlinkPath, "dir");
    writeFixtureFile(root, "apps/app/src/importer.mjs", 'import "./daemon/target.js";\n');

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "apps/app/src/importer.mjs",
          target: "@planview/daemon",
          specifier: "./daemon/target.js",
        },
      ]
    );
  });
});
