import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const allowedDependencies = new Map([
  ["@planview/core", []],
  ["@planview/storage", ["@planview/core"]],
  ["@planview/daemon", ["@planview/core", "@planview/storage"]],
  ["@planview/local", ["@planview/core", "@planview/storage", "@planview/daemon"]],
  ["@abijith-suresh/planview", ["@planview/local"]],
  ["@planview/app", []],
  ["@planview/site", []],
]);

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

const excludedDirectoryNames = new Set([
  "__tests__",
  "_generated",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "test",
  "tests",
]);

const sourceExtensions = new Set([
  ".astro",
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

const regexMetacharacters = new Set([".", "+", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"]);

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const getWorkspacePatterns = (manifest) => {
  const workspaces = manifest.workspaces;
  return Array.isArray(workspaces) ? workspaces : (workspaces?.packages ?? []);
};

const matchesPatternSegment = (name, pattern) => {
  if (pattern === "*") return true;
  if (!pattern.includes("*") && !pattern.includes("?")) return name === pattern;

  const escapedPattern = [...pattern]
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return regexMetacharacters.has(character) ? `\\${character}` : character;
    })
    .join("");
  const expression = new RegExp(`^${escapedPattern}$`);
  return expression.test(name);
};

const expandWorkspacePattern = (root, pattern) => {
  let paths = [root];

  for (const segment of pattern.split(/[\\/]+/).filter(Boolean)) {
    const nextPaths = [];
    for (const path of paths) {
      if (segment === "*" || segment.includes("?") || segment.includes("*")) {
        let entries;
        try {
          entries = readdirSync(path, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.isDirectory() && matchesPatternSegment(entry.name, segment)) {
            nextPaths.push(join(path, entry.name));
          }
        }
      } else {
        const candidate = join(path, segment);
        try {
          if (statSync(candidate).isDirectory()) nextPaths.push(candidate);
        } catch {
          // A workspace pattern may match no directories in this checkout.
        }
      }
    }
    paths = nextPaths;
  }

  return paths;
};

const discoverWorkspaces = (root) => {
  const rootManifest = readJson(join(root, "package.json"));
  const paths = new Set(
    getWorkspacePatterns(rootManifest).flatMap((pattern) => expandWorkspacePattern(root, pattern))
  );

  return [...paths]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((path) => {
      try {
        const manifestPath = join(path, "package.json");
        const manifest = readJson(manifestPath);
        if (typeof manifest.name !== "string") return [];
        return [{ path, manifest, manifestPath, name: manifest.name }];
      } catch {
        return [];
      }
    });
};

const isWithin = (candidate, parent) => {
  const pathFromParent = relative(parent, candidate);
  return (
    pathFromParent === "" || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== "..")
  );
};

const workspaceForPath = (path, workspaces) =>
  workspaces
    .filter((workspace) => isWithin(path, workspace.path))
    .sort((left, right) => right.path.length - left.path.length)[0];

const packageForSpecifier = (specifier, workspaceByName) => {
  for (const [name, workspace] of workspaceByName) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return workspace;
  }
};

const isExcludedPath = (path) => {
  const segments = path.split(/[\\/]+/);
  return (
    segments.some((segment) => excludedDirectoryNames.has(segment)) ||
    /(?:^|\.)(?:test|spec)\.[^.]+$/i.test(segments.at(-1) ?? "")
  );
};

const collectSourceFiles = (workspace) => {
  const files = [];
  const sourceRoots = ["src", "convex"]
    .map((name) => join(workspace.path, name))
    .filter((path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    });

  const visit = (path) => {
    if (isExcludedPath(path)) return;
    let entries;
    try {
      entries = readdirSync(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const childPath = join(path, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectoryNames.has(entry.name)) visit(childPath);
      } else if (entry.isFile() && !isExcludedPath(childPath)) {
        const extension = childPath.slice(childPath.lastIndexOf(".")).toLowerCase();
        if (sourceExtensions.has(extension)) files.push(childPath);
      }
    }
  };

  for (const sourceRoot of sourceRoots) visit(sourceRoot);
  return files.sort((left, right) => left.localeCompare(right));
};

const extractAstroFrontmatter = (contents) => {
  const match = contents.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? "";
};

const sourceTextForFile = (path) => {
  const contents = readFileSync(path, "utf8");
  return path.endsWith(".astro") ? extractAstroFrontmatter(contents) : contents;
};

const sourceKindForFile = (path) => {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (extension === ".astro" || extension === ".tsx" || extension === ".jsx") {
    return ts.ScriptKind.TSX;
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return ts.ScriptKind.JS;
  }
  return ts.ScriptKind.TS;
};

const moduleSpecifierFromImportType = (node) => {
  if (!ts.isLiteralTypeNode(node.argument)) return undefined;
  const literal = node.argument.literal;
  if (ts.isStringLiteral(literal) || ts.isNoSubstitutionTemplateLiteral(literal)) {
    return literal.text;
  }
};

const getModuleSpecifiers = (sourceFile) => {
  const specifiers = [];
  const addLiteral = (node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specifiers.push(node.text);
    }
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) addLiteral(reference.expression);
    } else if (ts.isImportTypeNode(node)) {
      const specifier = moduleSpecifierFromImportType(node);
      if (specifier !== undefined) specifiers.push(specifier);
    } else if (ts.isCallExpression(node)) {
      if (
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
        node.arguments.length > 0
      ) {
        addLiteral(node.arguments[0]);
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
};

const isDependencyAllowed = (sourceWorkspace, targetWorkspace) => {
  if (sourceWorkspace.name === targetWorkspace.name) return true;
  return (allowedDependencies.get(sourceWorkspace.name) ?? []).includes(targetWorkspace.name);
};

const createViolation = ({ file, kind, source, target, specifier }) => ({
  file,
  kind,
  source,
  target,
  specifier,
  message: `${file}: ${source} may not depend on ${target} through ${specifier}`,
});

/**
 * Find workspace dependencies that point against the repository's package DAG.
 * The repository root is configurable so the scanner can be exercised with fixtures.
 */
export const auditWorkspaceBoundaries = (repositoryRoot) => {
  const root = resolve(repositoryRoot);
  const workspaces = discoverWorkspaces(root);
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const violations = [];

  for (const workspace of workspaces) {
    for (const field of dependencyFields) {
      for (const name of Object.keys(workspace.manifest[field] ?? {})) {
        const target = workspaceByName.get(name);
        if (target && !isDependencyAllowed(workspace, target)) {
          violations.push(
            createViolation({
              file: relative(root, workspace.manifestPath).split(sep).join("/"),
              kind: "manifest",
              source: workspace.name,
              target: target.name,
              specifier: `${field}.${name}`,
            })
          );
        }
      }
    }

    for (const filePath of collectSourceFiles(workspace)) {
      const fileName = relative(root, filePath).split(sep).join("/");
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceTextForFile(filePath),
        ts.ScriptTarget.Latest,
        true,
        sourceKindForFile(filePath)
      );

      for (const specifier of getModuleSpecifiers(sourceFile)) {
        const packageTarget = packageForSpecifier(specifier, workspaceByName);
        const relativeTarget = specifier.startsWith(".")
          ? workspaceForPath(resolve(dirname(filePath), specifier), workspaces)
          : undefined;
        const target = packageTarget ?? relativeTarget;
        if (target && !isDependencyAllowed(workspace, target)) {
          violations.push(
            createViolation({
              file: fileName,
              kind: "import",
              source: workspace.name,
              target: target.name,
              specifier,
            })
          );
        }
      }
    }
  }

  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.specifier.localeCompare(right.specifier) ||
      left.target.localeCompare(right.target)
  );
};
