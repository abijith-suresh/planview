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
  skip: platform() === "win32",
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
  skip: platform() === "win32",
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
      "packages/core/src/create-require.mts",
      [
        'import { createRequire as makeRequire } from "node:module";',
        "const create = makeRequire;",
        "const createAlias = create;",
        "const load = createAlias(import.meta.url);",
        'load("@planview/daemon");',
        'const { createRequire: makeCjsRequire } = require("node:module");',
        "const loadStorage = makeCjsRequire(import.meta.url);",
        'loadStorage("@planview/storage");',
        'const makeCjsRequireAlias = require("node:module").createRequire;',
        "const loadDaemonAlias = makeCjsRequireAlias(__filename);",
        'loadDaemonAlias("@planview/daemon");',
        'const loadDaemonDirect = require("node:module").createRequire(__filename);',
        'loadDaemonDirect("@planview/daemon");',
        'import { createRequire as importedCreateRequire } from "node:module";',
        'importedCreateRequire(import.meta.url)("@planview/daemon");',
        'require("node:module").createRequire(__filename)("@planview/daemon");',
        'import Module = require("node:module");',
        "const loadFromImportEquals = Module.createRequire(__filename);",
        'loadFromImportEquals("@planview/daemon");',
      ].join("\n")
    );
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
        "const load = require;",
        'load("@planview/daemon");',
        "const loadModule = module.require;",
        'loadModule("@planview/daemon");',
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
        { file: "packages/core/src/create-require.mts", specifier: "@planview/daemon" },
        { file: "packages/core/src/create-require.mts", specifier: "@planview/daemon" },
        { file: "packages/core/src/create-require.mts", specifier: "@planview/daemon" },
        { file: "packages/core/src/create-require.mts", specifier: "@planview/daemon" },
        { file: "packages/core/src/create-require.mts", specifier: "@planview/daemon" },
        { file: "packages/core/src/create-require.mts", specifier: "@planview/daemon" },
        { file: "packages/core/src/create-require.mts", specifier: "@planview/storage" },
        { file: "packages/core/src/dependencies.ts", specifier: "../../storage/src/index.js" },
        { file: "packages/core/src/dependencies.ts", specifier: "@planview/daemon" },
        { file: "packages/core/src/dependencies.ts", specifier: "@planview/daemon" },
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

test("triple-slash type and path references are workspace edges with directive locations", () => {
  withFixture((root) => {
    writeFixtureFile(root, "packages/storage/src/reference.d.ts", "export interface Ref {}\n");
    writeFixtureFile(
      root,
      "packages/core/src/references.ts",
      [
        '/// <reference types="@planview/daemon" />',
        '/// <reference path="../../storage/src/reference.d.ts" />',
        "export {};",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(
        ({ file, kind, target, specifier, line, column, message }) => ({
          file,
          kind,
          target,
          specifier,
          line,
          column,
          message,
        })
      ),
      [
        {
          file: "packages/core/src/references.ts",
          kind: "import",
          target: "@planview/storage",
          specifier: "../../storage/src/reference.d.ts",
          message:
            "packages/core/src/references.ts:2:22: @planview/core may not depend on @planview/storage through ../../storage/src/reference.d.ts",
          line: 2,
          column: 22,
        },
        {
          file: "packages/core/src/references.ts",
          kind: "import",
          target: "@planview/daemon",
          specifier: "@planview/daemon",
          message:
            "packages/core/src/references.ts:1:23: @planview/core may not depend on @planview/daemon through @planview/daemon",
          line: 1,
          column: 23,
        },
      ]
    );
  });
});

test("require.resolve and import.meta.resolve calls are dependency references", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/app/src/resolve-apis.mts",
      [
        'require.resolve("@planview/core");',
        'import.meta.resolve("@planview/daemon");',
        "const loader = require;",
        'loader.resolve("@planview/storage");',
        "const object = { resolve: (specifier: string) => specifier };",
        'object.resolve("@planview/core");',
        "function shadowed(require: { resolve: (specifier: string) => string }) {",
        '  require.resolve("@planview/daemon");',
        "}",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ target, specifier }) => ({ target, specifier })),
      ["@planview/core", "@planview/daemon", "@planview/storage"].map((specifier) => ({
        target: specifier,
        specifier,
      }))
    );
  });
});

test("nonliteral require.resolve and import.meta.resolve calls fail closed", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/app/src/nonliteral-resolve.mts",
      [
        "const moduleName = getModuleName();",
        "require.resolve(moduleName);",
        "import.meta.resolve(moduleName);",
        "function shadowed(require: { resolve: (specifier: string) => string }) {",
        "  require.resolve(moduleName);",
        "}",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, kind, message }) => ({ file, kind, message })),
      [2, 3].map((line) => ({
        file: "apps/app/src/nonliteral-resolve.mts",
        kind: "unresolved-import",
        message: `apps/app/src/nonliteral-resolve.mts:${line}:1: module call must use a statically resolvable string literal`,
      }))
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
        "const load = require;",
        "const loadModule = module.require;",
        "load(moduleName);",
        "loadModule(moduleName);",
        'import { createRequire as makeRequire } from "node:module";',
        "const make = makeRequire;",
        "const loadFromModule = make(import.meta.url);",
        "loadFromModule(moduleName);",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, kind, message }) => ({ file, kind, message })),
      [2, 3, 4, 5, 8, 9, 13].map((line) => ({
        file: "apps/app/src/nonliteral.mjs",
        kind: "unresolved-import",
        message: `apps/app/src/nonliteral.mjs:${line}:1: module call must use a statically resolvable string literal`,
      }))
    );
  });
});

test("awaited node:module imports expose createRequire factories and loaders", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "packages/core/src/awaited-create-require.mts",
      [
        'const { createRequire } = await import("node:module");',
        "const loadFromNamed = createRequire(import.meta.url);",
        'loadFromNamed("@planview/daemon");',
        'createRequire(import.meta.url)("@planview/daemon");',
        'const moduleApi = await import("module");',
        "const loadFromNamespace = moduleApi.createRequire(import.meta.url);",
        'loadFromNamespace("@planview/daemon");',
        'moduleApi.createRequire(import.meta.url)("@planview/daemon");',
        'const makeRequire = (await import("node:module")).createRequire;',
        "const loadFromFactoryAlias = makeRequire(import.meta.url);",
        'loadFromFactoryAlias("@planview/daemon");',
        'makeRequire(import.meta.url)("@planview/daemon");',
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      Array.from({ length: 6 }, () => ({
        file: "packages/core/src/awaited-create-require.mts",
        target: "@planview/daemon",
        specifier: "@planview/daemon",
      }))
    );
  });
});

test("createRequire bindings survive TypeScript wrappers and default namespace access", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "packages/core/src/wrapped-create-require.mts",
      [
        'const makeAs = ((await import("node:module")) as typeof import("node:module")).createRequire;',
        'makeAs(import.meta.url)("@planview/daemon");',
        'const makeSatisfies = ((await import("node:module")) satisfies typeof import("node:module")).createRequire;',
        'makeSatisfies(import.meta.url)("@planview/daemon");',
        'const makeNonNull = ((await import("node:module"))!).createRequire;',
        'makeNonNull(import.meta.url)("@planview/daemon");',
        'const makeAssertion = (<typeof import("node:module")>(await import("node:module"))).createRequire;',
        'makeAssertion(import.meta.url)("@planview/daemon");',
        'const wrappedModuleApi = ((await import("node:module")) as typeof import("node:module"))!;',
        'wrappedModuleApi.createRequire(import.meta.url)("@planview/storage");',
        'const moduleApi = await import("node:module");',
        'moduleApi.default.createRequire(import.meta.url)("@planview/daemon");',
        'const defaultAlias = moduleApi["default"];',
        'defaultAlias.createRequire(import.meta.url)("@planview/storage");',
      ].join("\n")
    );

    const targets = auditWorkspaceBoundaries(root).map(({ target }) => target);
    assert.deepEqual(targets.sort(), [
      "@planview/daemon",
      "@planview/daemon",
      "@planview/daemon",
      "@planview/daemon",
      "@planview/daemon",
      "@planview/storage",
      "@planview/storage",
    ]);
  });
});

test("CommonJS module object aliases expose require without confusing namespaces or shadows", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "packages/core/src/cjs-module-aliases.cjs",
      [
        "const moduleAlias = module;",
        "const { require: loadAlias } = moduleAlias;",
        'loadAlias("@planview/daemon");',
        "const { require: loadDirect } = module;",
        'loadDirect("@planview/storage");',
        "function shadowedModule(module) {",
        "  const moduleAlias = module;",
        "  const { require: shadowedLoad } = moduleAlias;",
        '  shadowedLoad("@planview/daemon");',
        "}",
      ].join("\n")
    );
    writeFixtureFile(
      root,
      "apps/app/src/module-namespace-require.mts",
      [
        'import * as Module from "node:module";',
        'const moduleApi = await import("node:module");',
        "const { require: namespaceRequire } = Module;",
        "Module.require(moduleName);",
        "moduleApi.require(moduleName);",
        "namespaceRequire(moduleName);",
        "function shadowed(module) {",
        "  const moduleAlias = module;",
        "  const { require: localRequire } = moduleAlias;",
        "  localRequire(moduleName);",
        "}",
        "const cjsModuleAlias = module;",
        "const { require: load } = cjsModuleAlias;",
        "load(moduleName);",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, kind, target, specifier, message }) => ({
        file,
        kind,
        target,
        specifier,
        message,
      })),
      [
        {
          file: "apps/app/src/module-namespace-require.mts",
          kind: "unresolved-import",
          target: "<unresolved>",
          specifier: "<non-literal module call>",
          message:
            "apps/app/src/module-namespace-require.mts:14:1: module call must use a statically resolvable string literal",
        },
        {
          file: "packages/core/src/cjs-module-aliases.cjs",
          kind: "import",
          target: "@planview/daemon",
          specifier: "@planview/daemon",
          message:
            "packages/core/src/cjs-module-aliases.cjs: @planview/core may not depend on @planview/daemon through @planview/daemon",
        },
        {
          file: "packages/core/src/cjs-module-aliases.cjs",
          kind: "import",
          target: "@planview/storage",
          specifier: "@planview/storage",
          message:
            "packages/core/src/cjs-module-aliases.cjs: @planview/core may not depend on @planview/storage through @planview/storage",
        },
      ]
    );
  });
});

test("createRequire can be destructured from recognized module namespace aliases", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "packages/core/src/destructured-create-require.mts",
      [
        'import * as Module from "node:module";',
        "const ModuleAlias = Module;",
        "const { createRequire: makeStaticRequire } = ModuleAlias;",
        "const loadStatic = makeStaticRequire(import.meta.url);",
        'loadStatic("@planview/daemon");',
        'const awaitedModuleApi = await import("node:module");',
        "const { createRequire: makeAwaitedRequire } = awaitedModuleApi;",
        'makeAwaitedRequire(import.meta.url)("@planview/storage");',
        'const requiredModuleApi = require("node:module");',
        "const { createRequire: makeRequiredRequire } = requiredModuleApi;",
        'makeRequiredRequire(import.meta.url)("@planview/daemon");',
        'const { "createRequire": makeQuotedRequire } = await import("node:module");',
        'makeQuotedRequire(import.meta.url)("@planview/daemon");',
        'const quotedModuleApi = await import("node:module");',
        'const { "createRequire": makeQuotedAlias } = quotedModuleApi;',
        'makeQuotedAlias(import.meta.url)("@planview/storage");',
        'const { createRequire: makeModuleRequire } = module.require("node:module");',
        'makeModuleRequire(import.meta.url)("@planview/daemon");',
        'const { default: defaultModuleApi } = await import("node:module");',
        "const loadFromDefault = defaultModuleApi.createRequire(import.meta.url);",
        'loadFromDefault("@planview/storage");',
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        "@planview/daemon",
        "@planview/daemon",
        "@planview/daemon",
        "@planview/daemon",
        "@planview/storage",
        "@planview/storage",
        "@planview/storage",
      ].map((target) => ({
        file: "packages/core/src/destructured-create-require.mts",
        target,
        specifier: target,
      }))
    );
  });
});

test("static element access forms of module.require and createRequire are checked", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "packages/core/src/static-element-access.mts",
      [
        'module["require"]("@planview/daemon");',
        "const moduleAlias = module;",
        'moduleAlias["require"]("@planview/storage");',
        'const moduleApi = await import("node:module");',
        'const load = moduleApi["createRequire"](import.meta.url);',
        'load("@planview/daemon");',
        'const makeRequire = (await import("node:module"))["createRequire"];',
        "const loadFromFactory = makeRequire(import.meta.url);",
        'loadFromFactory("@planview/storage");',
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      ["@planview/daemon", "@planview/daemon", "@planview/storage", "@planview/storage"].map(
        (target) => ({
          file: "packages/core/src/static-element-access.mts",
          target,
          specifier: target,
        })
      )
    );
  });
});

test("nonliteral calls from awaited createRequire imports fail closed without binding shadowed names", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/app/src/dynamic-create-require.mts",
      [
        "const moduleName = getModuleName();",
        'const { createRequire } = await import("node:module");',
        "const load = createRequire(import.meta.url);",
        "load(moduleName);",
        'const moduleApi = await import("node:module");',
        "moduleApi.createRequire(import.meta.url)(moduleName);",
        "function shadowed(createRequire, moduleApi) {",
        "  createRequire(moduleName);",
        "  moduleApi.createRequire(import.meta.url)(moduleName);",
        "}",
        'const makeRequire = (await import("node:module")).createRequire;',
        "const loadFromFactoryAlias = makeRequire(import.meta.url);",
        "loadFromFactoryAlias(moduleName);",
        "function shadowedFactory(makeRequire) {",
        "  makeRequire(import.meta.url)(moduleName);",
        "}",
        'module["require"](moduleName);',
        "const moduleAlias = module;",
        'moduleAlias["require"](moduleName);',
        'const bracketModuleApi = await import("node:module");',
        'bracketModuleApi["createRequire"](import.meta.url)(moduleName);',
        "function shadowedElement(module, bracketModuleApi) {",
        '  module["require"](moduleName);',
        '  bracketModuleApi["createRequire"](import.meta.url)(moduleName);',
        "}",
        'import * as StaticModule from "node:module";',
        "const { createRequire: makeStaticRequire } = StaticModule;",
        "makeStaticRequire(import.meta.url)(moduleName);",
        'const awaitedModuleApi = await import("node:module");',
        "const { createRequire: makeAwaitedRequire } = awaitedModuleApi;",
        "makeAwaitedRequire(import.meta.url)(moduleName);",
        'const requiredModuleApi = require("node:module");',
        "const { createRequire: makeRequiredRequire } = requiredModuleApi;",
        "makeRequiredRequire(import.meta.url)(moduleName);",
        "function shadowedModuleNamespace(StaticModule) {",
        "  const { createRequire: shadowedCreateRequire } = StaticModule;",
        "  shadowedCreateRequire(import.meta.url)(moduleName);",
        "}",
        'const { "createRequire": makeQuotedRequire } = await import("node:module");',
        "makeQuotedRequire(import.meta.url)(moduleName);",
        'const quotedModuleApi = await import("node:module");',
        'const { "createRequire": makeQuotedAlias } = quotedModuleApi;',
        "makeQuotedAlias(import.meta.url)(moduleName);",
        "function shadowedQuotedNamespace(quotedModuleApi) {",
        '  const { "createRequire": shadowedQuotedRequire } = quotedModuleApi;',
        "  shadowedQuotedRequire(import.meta.url)(moduleName);",
        "}",
        'const { createRequire: makeModuleRequire } = module.require("node:module");',
        "makeModuleRequire(import.meta.url)(moduleName);",
        'const { default: defaultModuleApi } = await import("node:module");',
        "defaultModuleApi.createRequire(import.meta.url)(moduleName);",
        "function shadowedModuleRequire(module) {",
        '  const { createRequire: shadowedRequire } = module.require("node:module");',
        "  shadowedRequire(import.meta.url)(moduleName);",
        "}",
        "function shadowedDefault({ default: moduleApi }) {",
        "  moduleApi.createRequire(import.meta.url)(moduleName);",
        "}",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, kind, message }) => ({ file, kind, message })),
      [4, 6, 13, 17, 19, 21, 28, 31, 34, 40, 43, 49, 51].map((line) => ({
        file: "apps/app/src/dynamic-create-require.mts",
        kind: "unresolved-import",
        message: `apps/app/src/dynamic-create-require.mts:${line}:1: module call must use a statically resolvable string literal`,
      }))
    );
  });
});

test("loader alias detection respects lexical shadowing", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "packages/core/src/scoped-loader.cjs",
      [
        "const load = require;",
        'function shadowed(load) { load("@planview/daemon"); }',
        'load("@planview/storage");',
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "packages/core/src/scoped-loader.cjs",
          target: "@planview/storage",
          specifier: "@planview/storage",
        },
      ]
    );
  });
});

test("unshadowed CommonJS module aliases are checked while local module variables are ignored", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "packages/core/src/module-alias.cjs",
      [
        "const moduleAlias = module;",
        'moduleAlias.require("@planview/daemon");',
        "function shadowed(module) {",
        "  const localModule = module;",
        '  localModule.require("@planview/daemon");',
        '  module.require("@planview/daemon");',
        "}",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "packages/core/src/module-alias.cjs",
          target: "@planview/daemon",
          specifier: "@planview/daemon",
        },
      ]
    );
  });
});

test("module.require recognizes wrapped global receivers without binding shadows", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "packages/core/src/wrapped-module-require.mts",
      [
        '(module as NodeModule).require("@planview/daemon");',
        "const moduleAlias = module;",
        '(moduleAlias as NodeModule).require("@planview/storage");',
        "function shadowed(module: NodeModule) {",
        '  (module as NodeModule).require("@planview/daemon");',
        "}",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ target, specifier }) => ({ target, specifier })),
      ["@planview/daemon", "@planview/storage"].map((specifier) => ({
        target: specifier,
        specifier,
      }))
    );
  });
});

test("process.getBuiltinModule bootstraps node:module with aliases and respects shadowing", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/app/src/process-builtin-module.mts",
      [
        'const moduleApi = process.getBuiltinModule("node:module");',
        'moduleApi.createRequire(import.meta.url)("@planview/daemon");',
        'process.getBuiltinModule("node:module").createRequire(import.meta.url)("@planview/core");',
        "const processAlias = process;",
        'const moduleAlias = processAlias.getBuiltinModule("module");',
        'moduleAlias.createRequire(import.meta.url)("@planview/storage");',
        "function shadowed(process: { getBuiltinModule: (name: string) => unknown }) {",
        '  process.getBuiltinModule("node:module").createRequire(import.meta.url)("@planview/daemon");',
        "}",
        "const moduleName = getModuleName();",
        "moduleAlias.createRequire(import.meta.url)(moduleName);",
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ kind, target, message }) => ({
        kind,
        target,
        message,
      })),
      [
        {
          kind: "import",
          target: "@planview/core",
          message:
            "apps/app/src/process-builtin-module.mts: @planview/app may not depend on @planview/core through @planview/core",
        },
        {
          kind: "import",
          target: "@planview/daemon",
          message:
            "apps/app/src/process-builtin-module.mts: @planview/app may not depend on @planview/daemon through @planview/daemon",
        },
        {
          kind: "import",
          target: "@planview/storage",
          message:
            "apps/app/src/process-builtin-module.mts: @planview/app may not depend on @planview/storage through @planview/storage",
        },
        {
          kind: "unresolved-import",
          target: "<unresolved>",
          message:
            "apps/app/src/process-builtin-module.mts:11:1: module call must use a statically resolvable string literal",
        },
      ]
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

test("Astro template expression imports are checked", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/site/src/template-import.astro",
      '<p>{void import("@planview/daemon")}</p>\n'
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "apps/site/src/template-import.astro",
          target: "@planview/daemon",
          specifier: "@planview/daemon",
        },
      ]
    );
  });
});

test("Astro template expressions share loader bindings from frontmatter without name-only shadowing", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/site/src/shared-loader.astro",
      [
        "---",
        'import { createRequire } from "node:module";',
        "const load = createRequire(import.meta.url);",
        "---",
        '<p>{load("@planview/daemon")}</p>',
        '<p>{((load) => load("@planview/storage"))("shadowed")}</p>',
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "apps/site/src/shared-loader.astro",
          target: "@planview/daemon",
          specifier: "@planview/daemon",
        },
      ]
    );
  });
});

test("Astro only scans executable inline scripts", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/site/src/script-types.astro",
      [
        '<script type="text/plain">import("@planview/daemon");</script>',
        '<script type="application/json">import("@planview/storage");</script>',
        '<script type="module">import("@planview/daemon");</script>',
        '<script type="text/javascript">import("@planview/storage");</script>',
        '<script>import("@planview/core");</script>',
        '<script type={scriptType}>import("@planview/daemon");</script>',
      ].join("\n")
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ target, specifier }) => ({ target, specifier })),
      ["@planview/core", "@planview/daemon", "@planview/daemon", "@planview/storage"].map(
        (specifier) => ({ target: specifier, specifier })
      )
    );
  });
});

test("Astro bundled local script src values form source edges only when src is sole and relative", () => {
  withFixture((root) => {
    writeFixtureFile(root, "apps/site/src/scripts/local.js", "export const local = true;\n");
    writeFixtureFile(
      root,
      "apps/site/src/local-script-src.astro",
      [
        '<script src="./scripts/local.js"></script>',
        '<script src="https://cdn.example.test/library.js"></script>',
        '<script src="/public/library.js"></script>',
        "<script src={dynamicScript}></script>",
        '<script src="./scripts/local.js" is:inline></script>',
      ].join("\n")
    );

    assert.deepEqual(auditWorkspaceBoundaries(root), []);

    writeFixtureFile(root, "packages/daemon/src/entry.ts", "export const daemon = true;\n");
    writeFixtureFile(
      root,
      "apps/site/src/cross-workspace-script-src.astro",
      '<script src="../../../packages/daemon/src/entry.ts"></script>\n'
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "apps/site/src/cross-workspace-script-src.astro",
          target: "@planview/daemon",
          specifier: "../../../packages/daemon/src/entry.ts",
        },
      ]
    );
  });
});

test("Astro attribute and spread-attribute expression imports are checked", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/site/src/attribute-import.astro",
      '<div data-x={import("@planview/daemon")} {...import("@planview/storage")} />\n'
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "apps/site/src/attribute-import.astro",
          target: "@planview/daemon",
          specifier: "@planview/daemon",
        },
        {
          file: "apps/site/src/attribute-import.astro",
          target: "@planview/storage",
          specifier: "@planview/storage",
        },
      ]
    );
  });
});

test("Astro parser warnings do not hide boundary imports", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/site/src/set-html-warning.astro",
      '<div set:html="ignored">warning {import("@planview/daemon")}</div>\n'
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "apps/site/src/set-html-warning.astro",
          target: "@planview/daemon",
          specifier: "@planview/daemon",
        },
      ]
    );
  });
});

test("Astro diagnostic locations account for BOMs, CRLF, and astral Unicode", () => {
  withFixture((root) => {
    writeFixtureFile(
      root,
      "apps/site/src/bom.astro",
      "\uFEFF---\r\n---\r\n<p>😀 {import(moduleName)}</p>\r\n<script>import(moduleName);</script>\r\n"
    );

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, kind, message }) => ({ file, kind, message })),
      [
        {
          file: "apps/site/src/bom.astro",
          kind: "unresolved-import",
          message:
            "apps/site/src/bom.astro:3:8: module call must use a statically resolvable string literal",
        },
        {
          file: "apps/site/src/bom.astro",
          kind: "unresolved-import",
          message:
            "apps/site/src/bom.astro:4:9: module call must use a statically resolvable string literal",
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

test("source files use only TypeScript projects that include them", () => {
  withFixture((root) => {
    writeFixtureFile(root, "packages/daemon/src/entry.ts", "export const entry = true;\n");
    writeFixtureFile(root, "packages/storage/src/entry.ts", "export const entry = true;\n");
    writeFixtureFile(
      root,
      "apps/app/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@internal/*": ["../../packages/daemon/src/*"] },
        },
        include: ["src/**/*.ts"],
      })
    );
    writeFixtureFile(
      root,
      "apps/app/tsconfig.test.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@internal/*": ["../../packages/storage/src/*"] },
        },
        include: ["fixtures/**/*.ts"],
      })
    );
    writeFixtureFile(root, "apps/app/src/page.ts", 'import "@internal/entry";\n');
    writeFixtureFile(root, "apps/app/src/script.mts", 'import "@internal/entry";\n');
    writeFixtureFile(root, "apps/app/src/script.cjs", 'require("@internal/entry");\n');
    writeFixtureFile(root, "apps/app/fixtures/fixture.ts", 'import "@internal/entry";\n');
    writeFixtureFile(
      root,
      "apps/site/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@internal/*": ["../../packages/daemon/src/*"] },
        },
        include: ["src/**/*", "astro.config.ts"],
      })
    );
    writeFixtureFile(root, "apps/site/astro.config.ts", "export default {};\n");
    writeFixtureFile(
      root,
      "apps/site/tsconfig.test.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@internal/*": ["../../packages/storage/src/*"] },
        },
        include: ["fixtures/**/*.ts"],
      })
    );
    writeFixtureFile(
      root,
      "apps/site/src/page.astro",
      '---\nimport "@internal/entry";\n---\n<p>page</p>\n'
    );
    writeFixtureFile(root, "apps/site/fixtures/fixture.ts", 'import "@internal/entry";\n');

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "apps/app/fixtures/fixture.ts",
          target: "@planview/storage",
          specifier: "@internal/entry",
        },
        {
          file: "apps/app/src/page.ts",
          target: "@planview/daemon",
          specifier: "@internal/entry",
        },
        {
          file: "apps/app/src/script.cjs",
          target: "@planview/daemon",
          specifier: "@internal/entry",
        },
        {
          file: "apps/app/src/script.mts",
          target: "@planview/daemon",
          specifier: "@internal/entry",
        },
        {
          file: "apps/site/fixtures/fixture.ts",
          target: "@planview/storage",
          specifier: "@internal/entry",
        },
        {
          file: "apps/site/src/page.astro",
          target: "@planview/daemon",
          specifier: "@internal/entry",
        },
      ]
    );
  });
});

test("overlapping TypeScript projects fail closed when resolution is ambiguous", () => {
  withFixture((root) => {
    writeFixtureFile(root, "packages/daemon/src/entry.ts", "export const entry = true;\n");
    writeFixtureFile(root, "packages/storage/src/entry.ts", "export const entry = true;\n");
    for (const [config, target] of [
      ["tsconfig.json", "daemon"],
      ["tsconfig.typecheck.json", "storage"],
    ]) {
      writeFixtureFile(
        root,
        `apps/app/${config}`,
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@internal/*": [`../../packages/${target}/src/*`] },
          },
          include: ["src/**/*.ts"],
        })
      );
    }
    writeFixtureFile(root, "apps/app/src/page.ts", 'import "@internal/entry";\n');

    assert.throws(
      () => auditWorkspaceBoundaries(root),
      /Ambiguous TypeScript module resolution.*tsconfig\.json.*tsconfig\.typecheck\.json/
    );
  });
});

test("nested TypeScript configs override parent paths only for descendant sources", () => {
  withFixture((root) => {
    writeFixtureFile(root, "packages/daemon/src/entry.ts", "export const entry = true;\n");
    writeFixtureFile(
      root,
      "apps/app/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@internal/*": ["../../packages/daemon/src/*"] },
        },
      })
    );
    writeFixtureFile(
      root,
      "apps/app/src/feature/tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@internal/*": ["./local/*"] },
        },
      })
    );
    writeFixtureFile(root, "apps/app/src/feature/local/entry.ts", "export const entry = true;\n");
    writeFixtureFile(root, "apps/app/src/feature/page.ts", 'import "@internal/entry";\n');
    writeFixtureFile(root, "apps/app/src/root.ts", 'import "@internal/entry";\n');

    assert.deepEqual(
      auditWorkspaceBoundaries(root).map(({ file, target, specifier }) => ({
        file,
        target,
        specifier,
      })),
      [
        {
          file: "apps/app/src/root.ts",
          target: "@planview/daemon",
          specifier: "@internal/entry",
        },
      ]
    );
  });
});

test("symlinked TypeScript configs fail closed instead of hiding workspace path aliases", {
  skip: platform() === "win32",
}, () => {
  withFixture((root) => {
    writeFixtureFile(root, "packages/daemon/src/entry.ts", "export const entry = true;\n");
    writeFixtureFile(
      root,
      "apps/app/alias-config.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          paths: { "@internal-daemon/*": ["../../packages/daemon/src/*"] },
        },
      })
    );
    symlinkSync(
      join(root, "apps/app/alias-config.json"),
      join(root, "apps/app/tsconfig.json"),
      "file"
    );
    writeFixtureFile(root, "apps/app/src/alias.ts", 'import "@internal-daemon/entry";\n');

    assert.throws(
      () => auditWorkspaceBoundaries(root),
      /TypeScript config symlinks are unsupported: .*apps\/app\/tsconfig\.json/
    );
  });
});

test("source file and directory symlinks fail closed", {
  skip: platform() === "win32",
}, () => {
  withFixture((root) => {
    writeFixtureFile(root, "packages/daemon/src/target.js", "export const target = true;\n");
    writeFixtureFile(root, "apps/app/src/asset.json", "{}\n");
    writeFixtureFile(root, "apps/app/src/importer.mjs", 'import "./daemon/target.js";\n');

    const namedSourceSymlink = join(root, "apps/app/src/linked-target.ts");
    symlinkSync(join(root, "apps/app/src/asset.json"), namedSourceSymlink, "file");
    assert.throws(() => auditWorkspaceBoundaries(root), /Source symlink is unsupported/);

    rmSync(namedSourceSymlink);
    const extensionlessSourceSymlink = join(root, "apps/app/src/linked-target");
    symlinkSync(join(root, "packages/daemon/src/target.js"), extensionlessSourceSymlink, "file");
    assert.throws(() => auditWorkspaceBoundaries(root), /Source symlink is unsupported/);

    rmSync(extensionlessSourceSymlink);
    const directorySymlink = join(root, "apps/app/src/daemon");
    symlinkSync(join(root, "packages/daemon/src"), directorySymlink, "dir");
    assert.throws(() => auditWorkspaceBoundaries(root), /Source directory symlink is unsupported/);
  });
});

test("static asset file symlinks are skipped by the source scan", {
  skip: platform() === "win32",
}, () => {
  withFixture((root) => {
    writeFixtureFile(root, "apps/site/public/logo-target.svg", "<svg />\n");
    symlinkSync(
      join(root, "apps/site/public/logo-target.svg"),
      join(root, "apps/site/public/logo.svg"),
      "file"
    );
    symlinkSync(join(root, "packages/daemon/src"), join(root, "apps/app/.cache"), "dir");

    assert.deepEqual(auditWorkspaceBoundaries(root), []);
  });
});
