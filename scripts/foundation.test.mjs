import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

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
  expectProperty(packageJson.devDependencies, "typescript", "6.0.3", "TypeScript dependency");
  expectProperty(
    packageJson.scripts,
    "check",
    "npm run format:check && npm run lint && npm run test",
    "check script"
  );
  expectProperty(packageJson.scripts, "format", "biome format --write .", "format script");
  expectProperty(packageJson.scripts, "format:check", "biome format .", "format check script");
  expectProperty(packageJson.scripts, "lint", "biome lint .", "lint script");
  expectProperty(
    packageJson.scripts,
    "test",
    "node --test scripts/foundation.test.mjs",
    "test script"
  );
  expectProperty(packageJson.scripts, "verify", "npm run check", "verify script");

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
    "typescript",
    packageJson.devDependencies.typescript,
    "package-lock root TypeScript dependency"
  );
});
