import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
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
  ".astro",
  ".git",
  ".next",
  ".output",
  ".turbo",
  ".vercel",
  "__tests__",
  "__generated__",
  "_generated",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
  "out",
  "test",
  "tests",
]);

const additionalExcludedDirectoryNames = new Set([
  ".cache",
  ".vercel",
  ".wrangler",
  "test-results",
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

const expectedWorkspaceNames = [...allowedDependencies.keys()];

const getWorkspacePatterns = (manifest) => {
  const workspaces = manifest.workspaces;
  const patterns = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  if (!Array.isArray(patterns)) {
    throw new Error("Root package.json must define npm workspaces as an array of patterns.");
  }
  return patterns;
};

const isMissingPathError = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";

export const readDirectoryEntries = (
  path,
  readDirectory = (directory) => readdirSync(directory, { withFileTypes: true })
) => {
  try {
    return readDirectory(path);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
};

const readManifest = (path, repositoryRoot, { optional = false } = {}) => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if (optional && isMissingPathError(error)) return undefined;
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Package manifest symlinks are unsupported: ${path}`);
  }
  if (!stat.isFile()) throw new Error(`Package manifest is not a regular file: ${path}`);

  const realPath = realpathSync(path);
  if (!isWithinPath(realPath, repositoryRoot)) {
    throw new Error(`Package manifest escapes the repository root: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf8"));
};

const isExcludedWorkspaceDirectory = (name) =>
  excludedDirectoryNames.has(name) || additionalExcludedDirectoryNames.has(name);

const unsupportedWorkspacePattern = (pattern) => {
  throw new Error(
    `Unsupported npm workspace pattern ${JSON.stringify(pattern)}. ` +
      'Supported syntax uses literal path segments, "*" for one directory, and "**" for zero or more directories.'
  );
};

const parseWorkspacePattern = (pattern) => {
  if (
    typeof pattern !== "string" ||
    pattern.length === 0 ||
    isAbsolute(pattern) ||
    pattern.includes("\\") ||
    pattern.includes("//")
  ) {
    return unsupportedWorkspacePattern(pattern);
  }

  const segments = pattern.split("/");
  for (const segment of segments) {
    if (
      segment === "" ||
      segment === ".." ||
      (segment !== "." &&
        segment !== "*" &&
        segment !== "**" &&
        !/^[A-Za-z0-9._@-]+$/.test(segment))
    ) {
      return unsupportedWorkspacePattern(pattern);
    }
  }

  return segments.filter((segment) => segment !== ".");
};

const childDirectories = (path, { includeHidden = false } = {}) => {
  const entries = readDirectoryEntries(path);

  return entries
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.isSymbolicLink() &&
        !isExcludedWorkspaceDirectory(entry.name) &&
        (includeHidden || !entry.name.startsWith("."))
    )
    .map((entry) => join(path, entry.name));
};

const recursiveDirectories = (path) => {
  const descendants = [];
  const visit = (directory) => {
    for (const child of childDirectories(directory)) {
      descendants.push(child);
      visit(child);
    }
  };
  visit(path);
  return descendants;
};

const expandWorkspacePattern = (root, rootRealPath, pattern) => {
  const segments = parseWorkspacePattern(pattern);
  let paths = [root];

  for (const [index, segment] of segments.entries()) {
    const nextPaths = [];
    for (const path of paths) {
      if (segment === "*") {
        nextPaths.push(...childDirectories(path));
      } else if (segment === "**") {
        if (path !== root || index < segments.length - 1) nextPaths.push(path);
        nextPaths.push(...recursiveDirectories(path));
      } else {
        const candidate = join(path, segment);
        if (
          isDirectoryWithinRepository(candidate, rootRealPath) &&
          !isExcludedWorkspaceDirectory(segment)
        ) {
          nextPaths.push(candidate);
        }
      }
    }
    paths = nextPaths;
  }

  return paths;
};

const discoverWorkspaces = (root) => {
  const rootManifest = readManifest(join(root, "package.json"), root);
  const rootRealPath = realpathSync(root);
  const paths = new Set(
    getWorkspacePatterns(rootManifest).flatMap((pattern) =>
      expandWorkspacePattern(root, rootRealPath, pattern)
    )
  );

  const workspaces = [...paths]
    .sort((left, right) => left.localeCompare(right))
    .flatMap((path) => {
      const manifestPath = join(path, "package.json");
      const manifest = readManifest(manifestPath, root, { optional: true });
      if (!manifest) return [];
      if (typeof manifest.name !== "string") {
        throw new Error(`Workspace package manifest is missing its name field: ${manifestPath}`);
      }
      return [{ path, manifest, manifestPath, name: manifest.name }];
    });

  const names = new Set(workspaces.map((workspace) => workspace.name));
  const missing = expectedWorkspaceNames.filter((name) => !names.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Workspace discovery did not find required workspace(s): ${missing.join(", ")}. ` +
        `Discovered: ${[...names].sort().join(", ") || "none"}.`
    );
  }

  const duplicates = workspaces
    .map((workspace) => workspace.name)
    .filter((name, index, allNames) => allNames.indexOf(name) !== index);
  if (duplicates.length > 0) {
    throw new Error(
      `Workspace discovery found duplicate package name(s): ${[...new Set(duplicates)].join(", ")}.`
    );
  }

  return workspaces;
};

export const isWithinPath = (candidate, parent, pathApi = { relative, isAbsolute, sep }) => {
  const pathFromParent = pathApi.relative(parent, candidate);
  return (
    pathFromParent === "" ||
    (!pathApi.isAbsolute(pathFromParent) &&
      !pathFromParent.startsWith(`..${pathApi.sep}`) &&
      pathFromParent !== "..")
  );
};

const isDirectoryWithinRepository = (candidate, repositoryRoot) => {
  let stat;
  try {
    stat = lstatSync(candidate);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`Workspace pattern resolved to a symlink, which is unsupported: ${candidate}`);
  }
  if (!stat.isDirectory()) return false;

  const realPath = realpathSync(candidate);
  if (!isWithinPath(realPath, repositoryRoot)) {
    throw new Error(`Workspace pattern escapes the repository root: ${candidate}`);
  }
  return true;
};

const workspaceForPath = (path, workspaces) =>
  workspaces
    .filter((workspace) => isWithinPath(path, workspace.path))
    .sort((left, right) => right.path.length - left.path.length)[0];

const packageForSpecifier = (specifier, workspaceTargets) => {
  const name = [...workspaceTargets.keys()]
    .filter((candidate) => specifier === candidate || specifier.startsWith(`${candidate}/`))
    .sort((left, right) => right.length - left.length)[0];
  return name === undefined ? undefined : workspaceTargets.get(name);
};

const workspaceForNpmAlias = (specifier, workspaceByName) => {
  if (specifier.length === 0) {
    throw new Error("Unsupported empty npm alias target.");
  }

  for (const [name, workspace] of workspaceByName) {
    if (specifier === name || specifier.startsWith(`${name}@`)) return workspace;
  }
};

const workspaceForLocalAlias = (pathValue, sourceWorkspace, root, workspaces, description) => {
  if (pathValue.length === 0 || pathValue.includes("?") || pathValue.includes("#")) {
    throw new Error(`Cannot safely resolve local workspace alias ${JSON.stringify(description)}.`);
  }

  const candidate = resolve(dirname(sourceWorkspace.manifestPath), pathValue);
  let realPath;
  try {
    realPath = realpathSync(candidate);
  } catch {
    throw new Error(`Cannot resolve local workspace alias ${JSON.stringify(description)}.`);
  }

  if (isWithinPath(candidate, root) && !isWithinPath(realPath, root)) {
    throw new Error(
      `Local workspace alias escapes the repository root: ${JSON.stringify(description)}.`
    );
  }
  if (!isWithinPath(realPath, root)) return undefined;

  const target = workspaceForPath(realPath, workspaces);
  if (!target) {
    throw new Error(
      `Local workspace alias resolves inside the repository but outside a known workspace: ${JSON.stringify(description)}.`
    );
  }
  return target;
};

const resolveManifestDependency = (
  workspace,
  dependencyName,
  dependencyValue,
  root,
  workspaces,
  workspaceByName
) => {
  if (typeof dependencyValue !== "string") {
    return { target: workspaceByName.get(dependencyName), isAlias: false };
  }

  if (dependencyValue.startsWith("npm:")) {
    return {
      target: workspaceForNpmAlias(dependencyValue.slice("npm:".length), workspaceByName),
      isAlias: true,
    };
  }

  for (const protocol of ["file:", "link:"]) {
    if (dependencyValue.startsWith(protocol)) {
      return {
        target: workspaceForLocalAlias(
          dependencyValue.slice(protocol.length),
          workspace,
          root,
          workspaces,
          dependencyValue
        ),
        isAlias: true,
      };
    }
  }

  if (dependencyValue.startsWith("workspace:")) {
    const targetSpecifier = dependencyValue.slice("workspace:".length);
    if (
      targetSpecifier.startsWith("./") ||
      targetSpecifier.startsWith("../") ||
      isAbsolute(targetSpecifier)
    ) {
      return {
        target: workspaceForLocalAlias(
          targetSpecifier,
          workspace,
          root,
          workspaces,
          dependencyValue
        ),
        isAlias: true,
      };
    }

    const explicitTarget = workspaceForNpmAlias(targetSpecifier, workspaceByName);
    if (explicitTarget) return { target: explicitTarget, isAlias: true };

    const directTarget = workspaceByName.get(dependencyName);
    if (directTarget) return { target: directTarget, isAlias: false };

    throw new Error(
      `Cannot safely resolve workspace protocol alias ${JSON.stringify(dependencyValue)} for ${dependencyName}.`
    );
  }

  return { target: workspaceByName.get(dependencyName), isAlias: false };
};

const isExcludedPath = (path, workspaceRoot) => {
  const relativePath = relative(workspaceRoot, path);
  const segments = relativePath.split(/[\\/]+/);
  const fileName = segments.at(-1) ?? "";
  return (
    segments.some((segment) => excludedDirectoryNames.has(segment)) ||
    /(?:^|\.)(?:test|spec)\.[^.]+$/i.test(fileName) ||
    /(?:^|[._-])(?:gen|generated)\.[^.]+$/i.test(fileName)
  );
};

const collectSourceFiles = (workspace, workspaces) => {
  const files = [];

  const visit = (path) => {
    for (const childPath of childDirectories(path, { includeHidden: true })) {
      const childWorkspace = workspaceForPath(childPath, workspaces);
      if (childWorkspace && childWorkspace.path !== workspace.path) continue;
      visit(childPath);
    }
    const entries = readDirectoryEntries(path);
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isFile()) continue;
      const childPath = join(path, entry.name);
      if (
        !isExcludedPath(childPath, workspace.path) &&
        sourceExtensions.has(extname(childPath).toLowerCase())
      ) {
        files.push(childPath);
      }
    }
  };

  visit(workspace.path);
  return files.sort((left, right) => left.localeCompare(right));
};

const extractAstroScripts = (contents) => {
  const scripts = [];
  const frontmatter = contents.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (frontmatter) {
    const opening = contents.match(/^\uFEFF?---\r?\n/)?.[0] ?? "";
    scripts.push({
      text: frontmatter[1],
      lineOffset: contents.slice(0, opening.length).split("\n").length - 1,
      columnOffset: 0,
    });
  }

  const inlineScript = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;
  for (const match of contents.matchAll(inlineScript)) {
    const contentStart = match.index + match[0].indexOf(">") + 1;
    const lineStart = contents.lastIndexOf("\n", contentStart - 1) + 1;
    scripts.push({
      text: match[1],
      lineOffset: contents.slice(0, contentStart).split("\n").length - 1,
      columnOffset: contentStart - lineStart,
    });
  }
  return scripts;
};

const sourceTextsForFile = (path) => {
  const contents = readFileSync(path, "utf8");
  return path.endsWith(".astro")
    ? extractAstroScripts(contents)
    : [{ text: contents, lineOffset: 0, columnOffset: 0 }];
};

const sourceKindForFile = (path) => {
  const extension = extname(path).toLowerCase();
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
  const addLiteral = (node, sourceNode = node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specifiers.push({ specifier: node.text, node: sourceNode });
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
      if (specifier !== undefined) specifiers.push({ specifier, node });
    } else if (ts.isCallExpression(node)) {
      const isModuleRequire =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "module" &&
        node.expression.name.text === "require";
      const isModuleCall =
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require") ||
        isModuleRequire;
      if (isModuleCall) {
        const argument = node.arguments[0];
        if (
          argument &&
          (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
        ) {
          addLiteral(argument, node);
        } else {
          specifiers.push({ specifier: undefined, node });
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return specifiers;
};

const collectTypeScriptConfigs = (workspace) =>
  readDirectoryEntries(workspace.path)
    .filter(
      (entry) =>
        entry.isFile() && !entry.isSymbolicLink() && /^tsconfig(?:\..+)?\.json$/i.test(entry.name)
    )
    .map((entry) => join(workspace.path, entry.name))
    .sort((left, right) => left.localeCompare(right));

const getCompilerOptionsForWorkspace = (workspace) => {
  const options = [];
  for (const configPath of collectTypeScriptConfigs(workspace)) {
    const unrecoverableDiagnostics = [];
    const parsed = ts.getParsedCommandLineOfConfigFile(
      configPath,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          unrecoverableDiagnostics.push(diagnostic);
        },
      }
    );
    const diagnostics = [...(parsed?.errors ?? []), ...unrecoverableDiagnostics];
    if (!parsed || diagnostics.length > 0) {
      const details = diagnostics
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
        .join("; ");
      throw new Error(
        `Cannot parse TypeScript config ${configPath}${details ? `: ${details}` : "."}`
      );
    }
    options.push(parsed.options);
  }
  if (options.length === 0) options.push({ moduleResolution: ts.ModuleResolutionKind.Node10 });
  return options;
};

const resolvedWorkspaceTargets = (specifier, containingFile, compilerOptions, workspaces) => {
  const targets = new Set();
  let isResolved = false;
  for (const options of compilerOptions) {
    const result = ts.resolveModuleName(specifier, containingFile, options, ts.sys);
    const resolvedFileName = result.resolvedModule?.resolvedFileName;
    if (!resolvedFileName) continue;
    isResolved = true;

    let canonicalPath;
    try {
      canonicalPath = realpathSync(resolvedFileName);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
    const target = workspaceForPath(canonicalPath, workspaces);
    if (target) targets.add(target);
  }
  return { isResolved, targets };
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
  const root = realpathSync(resolve(repositoryRoot));
  const workspaces = discoverWorkspaces(root);
  const workspaceByName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const violations = [];

  for (const workspace of workspaces) {
    const workspaceImportTargets = new Map(workspaceByName);
    for (const field of dependencyFields) {
      for (const [name, value] of Object.entries(workspace.manifest[field] ?? {})) {
        const { target, isAlias } = resolveManifestDependency(
          workspace,
          name,
          value,
          root,
          workspaces,
          workspaceByName
        );

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

        if (target) workspaceImportTargets.set(name, target);
        else if (isAlias) workspaceImportTargets.set(name, null);
      }
    }

    const compilerOptions = getCompilerOptionsForWorkspace(workspace);
    for (const filePath of collectSourceFiles(workspace, workspaces)) {
      const fileName = relative(root, filePath).split(sep).join("/");
      for (const { text, lineOffset, columnOffset } of sourceTextsForFile(filePath)) {
        const sourceFile = ts.createSourceFile(
          filePath,
          text,
          ts.ScriptTarget.Latest,
          true,
          sourceKindForFile(filePath)
        );
        for (const { specifier, node } of getModuleSpecifiers(sourceFile)) {
          const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          if (specifier === undefined) {
            const sourceColumn = start.character + (start.line === 0 ? columnOffset : 0) + 1;
            const location = `${fileName}:${start.line + lineOffset + 1}:${sourceColumn}`;
            violations.push({
              file: fileName,
              kind: "unresolved-import",
              source: workspace.name,
              target: "<unresolved>",
              specifier: "<non-literal module call>",
              message: `${location}: module call must use a statically resolvable string literal`,
            });
            continue;
          }

          const resolution = resolvedWorkspaceTargets(
            specifier,
            filePath,
            compilerOptions,
            workspaces
          );
          const targets = resolution.targets;

          if (!resolution.isResolved) {
            const packageTarget = packageForSpecifier(specifier, workspaceImportTargets);
            if (packageTarget) targets.add(packageTarget);

            if (specifier.startsWith(".")) {
              const relativeTarget = workspaceForPath(
                resolve(dirname(filePath), specifier),
                workspaces
              );
              if (relativeTarget) targets.add(relativeTarget);
            }
          }

          for (const target of targets) {
            if (!isDependencyAllowed(workspace, target)) {
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
    }
  }

  return violations.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.specifier.localeCompare(right.specifier) ||
      left.target.localeCompare(right.target)
  );
};
