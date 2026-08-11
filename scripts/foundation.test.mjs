import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const readText = (file) => {
  try {
    return readFileSync(resolve(root, file), "utf8");
  } catch (error) {
    assert.fail(`${file} should be readable: ${error.message}`);
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(readText(file));
  } catch (error) {
    assert.fail(`${file} should contain valid JSON: ${error.message}`);
  }
};

const expectEqual = (actual, expected, description) => {
  assert.deepEqual(actual, expected, `${description} is incorrect`);
};

const expectProperty = (object, property, expected, description) => {
  assert.equal(object?.[property], expected, `${description} is incorrect`);
};

test("repository foundation has the expected configuration", () => {
  expectEqual(readText(".node-version").trim(), "24.19.0", ".node-version");

  const biome = readJson("biome.json");
  expectEqual(biome.$schema, "https://biomejs.dev/schemas/2.5.7/schema.json", "Biome schema");
  expectProperty(biome.vcs, "enabled", true, "Biome VCS enabled setting");
  expectProperty(biome.vcs, "clientKind", "git", "Biome VCS client kind");
  expectProperty(biome.vcs, "useIgnoreFile", true, "Biome VCS ignore-file setting");
  expectProperty(biome.formatter, "indentStyle", "space", "Biome formatter indent style");
  expectProperty(biome.formatter, "indentWidth", 2, "Biome formatter indent width");
  expectProperty(biome.formatter, "lineWidth", 100, "Biome formatter line width");
  expectProperty(biome.linter?.rules, "preset", "recommended", "Biome lint preset");
  expectProperty(
    biome.linter?.rules?.correctness,
    "noUnusedVariables",
    "error",
    "Biome correctness noUnusedVariables rule"
  );
  expectProperty(biome.linter?.rules?.style, "useConst", "error", "Biome style useConst rule");
  expectProperty(
    biome.linter?.rules?.suspicious,
    "noConsole",
    "warn",
    "Biome suspicious noConsole rule"
  );
  expectProperty(biome.linter?.rules?.suspicious, "noVar", "error", "Biome suspicious noVar rule");
  expectProperty(
    biome.overrides?.[0]?.linter?.rules?.a11y,
    "useAnchorContent",
    "off",
    "Biome Markdown a11y rule override"
  );
  expectProperty(
    biome.javascript?.formatter,
    "quoteStyle",
    "double",
    "Biome JavaScript quote style"
  );
  expectProperty(
    biome.javascript?.formatter,
    "semicolons",
    "always",
    "Biome JavaScript semicolons"
  );
  expectProperty(
    biome.javascript?.formatter,
    "trailingCommas",
    "es5",
    "Biome JavaScript trailing commas"
  );
  expectProperty(
    biome.javascript?.formatter,
    "bracketSpacing",
    true,
    "Biome JavaScript bracket spacing"
  );
  expectProperty(
    biome.javascript?.formatter,
    "arrowParentheses",
    "always",
    "Biome JavaScript arrow parentheses"
  );

  const tsBase = readJson("tsconfig.base.json");
  const requiredCompilerOptions = {
    target: "ES2024",
    lib: ["ES2024"],
    module: "NodeNext",
    moduleResolution: "NodeNext",
    strict: true,
    skipLibCheck: true,
    verbatimModuleSyntax: true,
    erasableSyntaxOnly: true,
    forceConsistentCasingInFileNames: true,
    noUncheckedIndexedAccess: true,
    noFallthroughCasesInSwitch: true,
    noImplicitOverride: true,
    noPropertyAccessFromIndexSignature: true,
    exactOptionalPropertyTypes: true,
  };
  for (const [option, value] of Object.entries(requiredCompilerOptions)) {
    expectEqual(tsBase.compilerOptions?.[option], value, `TypeScript compiler option ${option}`);
  }

  const rootTsConfig = readJson("tsconfig.json");
  expectEqual(rootTsConfig.extends, "./tsconfig.base.json", "root TypeScript extends");
  expectEqual(rootTsConfig.files, [], "root TypeScript files");
  expectEqual(rootTsConfig.include, [], "root TypeScript include");

  const packageJson = readJson("package.json");
  expectEqual(packageJson.private, true, "package privacy");
  expectEqual(packageJson.type, "module", "package module type");
  expectEqual(packageJson.workspaces, ["apps/*", "packages/*"], "workspaces");
  expectProperty(packageJson.engines, "node", ">=24.19.0 <25", "Node engine");
  expectProperty(packageJson.engines, "npm", ">=11.16.0", "npm engine");
  expectProperty(packageJson, "packageManager", "npm@11.16.0", "package manager");
  expectProperty(packageJson.devDependencies, "@biomejs/biome", "2.5.7", "Biome dependency");
  expectProperty(packageJson.devDependencies, "@changesets/cli", "2.31.1", "Changesets dependency");
  expectProperty(
    packageJson.devDependencies,
    "@changesets/parse",
    "0.4.3",
    "Changesets parser dependency"
  );
  expectProperty(packageJson.devDependencies, "semver", "7.8.5", "SemVer dependency");
  expectProperty(packageJson.devDependencies, "typescript", "6.0.3", "TypeScript dependency");
  expectProperty(
    packageJson.scripts,
    "build",
    "npm run build --workspaces --if-present",
    "build script"
  );
  expectProperty(
    packageJson.scripts,
    "check",
    "npm run release-policy && npm run format:check && npm run lint && npm run typecheck && npm run test",
    "check script"
  );
  expectProperty(packageJson.scripts, "format", "biome format --write .", "format script");
  expectProperty(packageJson.scripts, "format:check", "biome format .", "format check script");
  expectProperty(
    packageJson.scripts,
    "release-policy",
    "node scripts/release-policy.mjs",
    "release-policy script"
  );
  expectProperty(packageJson.scripts, "lint", "biome lint .", "lint script");
  expectProperty(
    packageJson.scripts,
    "test",
    "node --test scripts/foundation.test.mjs scripts/release-policy.test.mjs && npm run test --workspaces --if-present",
    "test script"
  );
  expectProperty(
    packageJson.scripts,
    "typecheck",
    "npm run typecheck --workspaces --if-present",
    "typecheck script"
  );
  expectProperty(packageJson.scripts, "verify", "npm run check && npm run build", "verify script");
  expectProperty(
    packageJson.scripts,
    "version-packages",
    "npm run release-policy && changeset version",
    "version-packages script"
  );
  expectProperty(
    packageJson.scripts,
    "release",
    "npm run release-policy && npm run verify && npm run pack:check && changeset publish",
    "release script"
  );

  const cliPackageJson = readJson("apps/cli/package.json");
  expectEqual(cliPackageJson.name, "planview", "CLI package name");
  expectEqual(cliPackageJson.type, "module", "CLI package module type");
  expectProperty(cliPackageJson.bin, "planview", "./dist/index.js", "CLI bin mapping");
  expectEqual(cliPackageJson.files, ["dist", "README.md"], "CLI publish files");
  expectProperty(
    cliPackageJson.scripts,
    "build",
    "npm run build --workspace @planview/daemon && tsc --project tsconfig.json && node scripts/bundle.mjs && node scripts/make-executable.mjs dist/index.js",
    "CLI build script"
  );
  expectProperty(cliPackageJson.scripts, "prepack", "npm run build", "CLI prepack script");
  expectProperty(
    cliPackageJson.scripts,
    "typecheck",
    "npm run build --workspace @planview/daemon && tsc --project tsconfig.json --noEmit",
    "CLI typecheck script"
  );
  expectProperty(
    cliPackageJson.scripts,
    "test",
    "npm run build && node --test test/cli.test.mjs",
    "CLI test script"
  );

  const corePackageJson = readJson("packages/core/package.json");
  expectEqual(corePackageJson.name, "@planview/core", "core package name");
  expectEqual(corePackageJson.private, true, "core package privacy");
  expectEqual(corePackageJson.type, "module", "core package module type");
  expectProperty(
    corePackageJson.scripts,
    "build",
    "tsc --build tsconfig.json",
    "core build script"
  );
  expectProperty(
    corePackageJson.scripts,
    "test",
    "npm run build && node --test test/core.test.mjs test/core-identifiers.test.mjs test/core-source-validation.test.mjs",
    "core test script"
  );
  expectProperty(
    corePackageJson.scripts,
    "typecheck",
    "tsc --project tsconfig.typecheck.json",
    "core typecheck script"
  );
  const coreTsConfig = readJson("packages/core/tsconfig.json");
  expectProperty(coreTsConfig.compilerOptions, "composite", true, "core composite build setting");
  expectProperty(
    coreTsConfig.compilerOptions,
    "tsBuildInfoFile",
    "dist/.tsbuildinfo",
    "core build state location"
  );
  const coreTypecheckTsConfig = readJson("packages/core/tsconfig.typecheck.json");
  expectEqual(
    coreTypecheckTsConfig.compilerOptions,
    { noEmit: true, composite: false },
    "core clean-checkout typecheck compiler options"
  );

  const storagePackageJson = readJson("packages/storage/package.json");
  expectEqual(storagePackageJson.name, "@planview/storage", "storage package name");
  expectEqual(storagePackageJson.private, true, "storage package privacy");
  expectEqual(storagePackageJson.type, "module", "storage package module type");
  expectProperty(
    storagePackageJson.scripts,
    "build",
    "tsc --build tsconfig.json",
    "storage build script"
  );
  expectProperty(
    storagePackageJson.scripts,
    "test",
    "npm run build && node --test test/storage.test.mjs test/document-files.test.mjs test/publication.test.mjs",
    "storage test script"
  );
  expectProperty(
    storagePackageJson.scripts,
    "typecheck",
    "tsc --project tsconfig.typecheck.json",
    "storage typecheck script"
  );
  const storageTsConfig = readJson("packages/storage/tsconfig.json");
  expectProperty(
    storageTsConfig.compilerOptions,
    "composite",
    true,
    "storage composite build setting"
  );
  expectProperty(
    storageTsConfig.compilerOptions,
    "tsBuildInfoFile",
    "dist/.tsbuildinfo",
    "storage build state location"
  );
  expectEqual(
    storageTsConfig.references,
    [{ path: "../core" }],
    "storage TypeScript project references"
  );
  const storageTypecheckTsConfig = readJson("packages/storage/tsconfig.typecheck.json");
  expectEqual(
    storageTypecheckTsConfig.compilerOptions,
    {
      noEmit: true,
      composite: false,
      rootDir: "..",
      paths: { "@planview/core": ["../core/src/index.ts"] },
    },
    "storage clean-checkout typecheck compiler options"
  );
  expectProperty(
    storagePackageJson.dependencies,
    "effect",
    "4.0.0-beta.107",
    "storage Effect dependency"
  );

  const lockfile = readJson("package-lock.json");
  expectEqual(lockfile.lockfileVersion, 3, "lockfile version");
  assert.ok(
    lockfile.packages && typeof lockfile.packages[""] === "object",
    "package-lock.json should have a root package entry"
  );
  const lockRoot = lockfile.packages[""];
  expectProperty(lockRoot, "name", packageJson.name, "package-lock root name");
  expectEqual(lockRoot.workspaces, packageJson.workspaces, "package-lock root workspaces");
  expectProperty(
    lockRoot.engines,
    "node",
    packageJson.engines.node,
    "package-lock root Node engine"
  );
  expectProperty(lockRoot.engines, "npm", packageJson.engines.npm, "package-lock root npm engine");
  expectProperty(
    lockRoot.devDependencies,
    "@biomejs/biome",
    packageJson.devDependencies["@biomejs/biome"],
    "package-lock root Biome dependency"
  );
  expectProperty(
    lockRoot.devDependencies,
    "@changesets/parse",
    packageJson.devDependencies["@changesets/parse"],
    "package-lock root Changesets parser dependency"
  );
  expectProperty(
    lockRoot.devDependencies,
    "semver",
    packageJson.devDependencies.semver,
    "package-lock root SemVer dependency"
  );
  expectProperty(
    lockRoot.devDependencies,
    "typescript",
    packageJson.devDependencies.typescript,
    "package-lock root TypeScript dependency"
  );

  const coreLockPackage = lockfile.packages["packages/core"];
  expectProperty(coreLockPackage, "name", corePackageJson.name, "package-lock core package name");
  expectProperty(coreLockPackage, "version", corePackageJson.version, "package-lock core version");

  const storageLockPackage = lockfile.packages["packages/storage"];
  expectProperty(
    storageLockPackage,
    "name",
    storagePackageJson.name,
    "package-lock storage package name"
  );
  expectProperty(
    storageLockPackage,
    "version",
    storagePackageJson.version,
    "package-lock storage version"
  );
});
