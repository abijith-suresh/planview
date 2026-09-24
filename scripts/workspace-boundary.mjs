import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const astroCompiler = require("@astrojs/compiler/sync");

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
    segments.some(
      (segment) =>
        excludedDirectoryNames.has(segment) || additionalExcludedDirectoryNames.has(segment)
    ) ||
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
      const childPath = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        if (isExcludedPath(childPath, workspace.path)) continue;
        const target = statSync(childPath);
        if (target.isDirectory()) {
          throw new Error(`Source directory symlink is unsupported: ${childPath}`);
        }
        if (target.isFile()) {
          const targetPath = realpathSync(childPath);
          if (
            sourceExtensions.has(extname(childPath).toLowerCase()) ||
            sourceExtensions.has(extname(targetPath).toLowerCase())
          ) {
            throw new Error(`Source symlink is unsupported: ${childPath}`);
          }
          continue;
        }
        throw new Error(`Unsupported source symlink target: ${childPath}`);
      }
      if (!entry.isFile()) continue;
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

const extractAstroScripts = (contents, path) => {
  const { ast, diagnostics } = astroCompiler.parse(contents);
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 1);
  if (errors.length > 0) {
    const details = errors.map((diagnostic) => diagnostic.text).join("; ");
    throw new Error(`Cannot parse Astro source ${path}${details ? `: ${details}` : "."}`);
  }

  const frontmatter = [];
  const templateExpressions = [];
  const scripts = [];
  const scriptSourceImports = [];
  const lineStarts = [0];
  for (const match of contents.matchAll(/\r\n|[\r\n]/g)) {
    lineStarts.push(match.index + match[0].length);
  }
  const sourceOffset = ({ line, column }) => lineStarts[line - 1] + column - 1;
  const addText = (node, kind) => {
    if (typeof node.value === "string" && node.value.length > 0) {
      const startOffset = contents.indexOf(node.value, sourceOffset(node.position.start));
      if (startOffset < 0) {
        throw new Error(`Cannot locate Astro expression source in ${path}.`);
      }
      const segment = { text: node.value, startOffset };
      (kind === "script" ? scripts : templateExpressions).push(segment);
    }
    for (const child of node.children ?? []) addText(child, kind);
  };
  const addAttributeExpression = (attribute) => {
    const text = attribute.kind === "spread" ? attribute.name : attribute.value;
    if (typeof text !== "string" || text.length === 0) return;
    const parserStart = sourceOffset(attribute.position.start);
    const startOffset =
      attribute.kind === "spread" ? parserStart : contents.indexOf(text, parserStart);
    if (startOffset < 0) {
      throw new Error(`Cannot locate Astro attribute expression source in ${path}.`);
    }
    templateExpressions.push({ text, startOffset });
  };
  const isExecutableScript = (element) => {
    const typeAttribute = element.attributes?.find(
      (attribute) => attribute.name?.toLowerCase() === "type"
    );
    if (!typeAttribute || typeAttribute.kind === "expression") return true;

    const type = typeof typeAttribute.value === "string" ? typeAttribute.value.trim() : "";
    if (type.length === 0) return true;
    const mediaType = type.split(";", 1)[0].trim().toLowerCase();
    return (
      mediaType === "module" ||
      /^(?:text|application)\/(?:x-)?(?:javascript|ecmascript|jscript)(?:[0-9]+(?:\.[0-9]+)?)?$/.test(
        mediaType
      )
    );
  };
  const visit = (node, inScript = false) => {
    if (node.type === "frontmatter") {
      const startOffset = contents.indexOf(node.value);
      if (startOffset < 0) {
        throw new Error(`Cannot locate Astro frontmatter source in ${path}.`);
      }
      frontmatter.push({ text: node.value, startOffset });
      return;
    }
    if (node.type === "expression") {
      for (const child of node.children ?? []) addText(child, "template");
      return;
    }
    if (inScript && node.type === "text") {
      addText(node, "script");
      return;
    }

    const isScript =
      inScript || (node.type === "element" && node.name === "script" && isExecutableScript(node));
    if (
      node.type === "element" &&
      node.name === "script" &&
      node.attributes?.length === 1 &&
      node.attributes[0].name?.toLowerCase() === "src" &&
      node.attributes[0].kind === "quoted" &&
      typeof node.attributes[0].value === "string"
    ) {
      const specifier = node.attributes[0].value;
      const extension = extname(specifier).toLowerCase();
      if (
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        extension !== ".astro" &&
        sourceExtensions.has(extension)
      ) {
        const startOffset = contents.indexOf(
          specifier,
          sourceOffset(node.attributes[0].position.start)
        );
        if (startOffset < 0) {
          throw new Error(`Cannot locate Astro script src in ${path}.`);
        }
        scriptSourceImports.push({ specifier, startOffset });
      }
    }
    for (const attribute of node.attributes ?? []) {
      if (attribute.kind === "expression" || attribute.kind === "spread") {
        addAttributeExpression(attribute);
      }
    }
    for (const child of node.children ?? []) visit(child, isScript);
  };
  visit(ast);
  return { frontmatter, templateExpressions, scripts, scriptSourceImports };
};

const createMappedSourceUnit = (parts) => {
  let text = "";
  const mappings = [];
  for (const part of parts) {
    const sourceStartOffset = part.sourceStartOffset ?? part.startOffset;
    const start = text.length;
    text += part.text;
    if (sourceStartOffset !== undefined) {
      mappings.push({
        start,
        end: text.length,
        sourceStartOffset,
      });
    }
  }

  return {
    text,
    sourceOffsetAt(offset) {
      const mapping = mappings.find(({ start, end }) => offset >= start && offset < end);
      if (!mapping) throw new Error(`Cannot map analysis offset ${offset} to source.`);
      return mapping.sourceStartOffset + offset - mapping.start;
    },
  };
};

const sourceTextsForFile = (path) => {
  const contents = readFileSync(path, "utf8");
  if (!path.endsWith(".astro")) {
    return {
      contents,
      units: [createMappedSourceUnit([{ text: contents, sourceStartOffset: 0 }])],
    };
  }

  const { frontmatter, templateExpressions, scripts, scriptSourceImports } = extractAstroScripts(
    contents,
    path
  );
  const templateParts = [];
  for (const segment of frontmatter) {
    templateParts.push(segment, { text: "\n" });
  }
  for (const segment of templateExpressions) {
    templateParts.push({ text: "\n; void (\n" }, segment, { text: "\n);\n" });
  }

  return {
    contents,
    units: [
      ...(templateParts.length > 0 ? [createMappedSourceUnit(templateParts)] : []),
      ...scripts.map((segment) => createMappedSourceUnit([segment])),
      ...scriptSourceImports.map(({ specifier, startOffset }) =>
        createMappedSourceUnit([{ text: `import(${JSON.stringify(specifier)})`, startOffset }])
      ),
    ],
  };
};

const sourceLocation = (contents, offset) => {
  const precedingText = contents.slice(0, offset);
  const lines = precedingText.split(/\r\n|[\r\n]/);
  return { line: lines.length, column: lines.at(-1).length + 1 };
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

const createSourceChecker = (sourceFile) => {
  const fileName = resolve(sourceFile.fileName);
  const compilerOptions = {
    allowJs: true,
    noLib: true,
    noResolve: true,
    skipLibCheck: true,
    types: [],
  };
  const defaultHost = ts.createCompilerHost(compilerOptions);
  const host = {
    ...defaultHost,
    getSourceFile: (path, languageVersion, onError, shouldCreateNewSourceFile) =>
      resolve(path) === fileName
        ? sourceFile
        : defaultHost.getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile),
    fileExists: (path) => resolve(path) === fileName || defaultHost.fileExists(path),
    readFile: (path) => (resolve(path) === fileName ? sourceFile.text : defaultHost.readFile(path)),
  };
  const program = ts.createProgram([fileName], compilerOptions, host);
  return program.getTypeChecker();
};

const getModuleSpecifiers = (sourceFile) => {
  const analysisFile = sourceFile.fileName.endsWith(".astro")
    ? ts.createSourceFile(
        `${sourceFile.fileName}.tsx`,
        sourceFile.text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      )
    : sourceFile;
  const checker = createSourceChecker(analysisFile);
  const specifiers = [];
  const bindingKinds = new Map();
  const declarations = [];
  const addLiteral = (node, sourceNode = node) => {
    if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) {
      specifiers.push({ specifier: node.text, node: sourceNode });
    }
  };
  const unwrapExpression = (expression) => {
    let candidate = expression;
    while (true) {
      if (
        ts.isParenthesizedExpression(candidate) ||
        ts.isAsExpression(candidate) ||
        ts.isSatisfiesExpression(candidate) ||
        ts.isNonNullExpression(candidate) ||
        ts.isTypeAssertionExpression(candidate)
      ) {
        candidate = candidate.expression;
      } else {
        break;
      }
    }
    return candidate;
  };
  const symbolFor = (node) => checker.getSymbolAtLocation(node);
  const kindFor = (node) => {
    const symbol = symbolFor(node);
    return symbol ? bindingKinds.get(symbol) : undefined;
  };
  const isUnshadowedBuiltin = (node, builtinName) => {
    if (!ts.isIdentifier(node) || node.text !== builtinName) return false;
    const symbol = symbolFor(node);
    return (
      !symbol ||
      (!symbol.declarations?.some((declaration) => declaration.getSourceFile() === analysisFile) &&
        !kindFor(node))
    );
  };
  const bind = (node, kind) => {
    const symbol = symbolFor(node);
    if (symbol && !bindingKinds.has(symbol)) {
      bindingKinds.set(symbol, kind);
      return true;
    }
    return false;
  };
  const isNodeModule = (specifier) =>
    (ts.isStringLiteral(specifier) || ts.isNoSubstitutionTemplateLiteral(specifier)) &&
    (specifier.text === "node:module" || specifier.text === "module");
  const isProcessReference = (expression) => {
    const candidate = unwrapExpression(expression);
    return (
      ts.isIdentifier(candidate) &&
      (kindFor(candidate) === "process" || isUnshadowedBuiltin(candidate, "process"))
    );
  };
  const isProcessGetBuiltinModuleCall = (expression) => {
    const candidate = unwrapExpression(expression);
    if (!ts.isCallExpression(candidate)) return false;
    const member = unwrapExpression(candidate.expression);
    return (
      (ts.isPropertyAccessExpression(member) || ts.isElementAccessExpression(member)) &&
      staticMemberName(member) === "getBuiltinModule" &&
      isProcessReference(member.expression) &&
      candidate.arguments.some(isNodeModule)
    );
  };
  const staticMemberName = (expression) => {
    const candidate = unwrapExpression(expression);
    if (ts.isPropertyAccessExpression(candidate)) return candidate.name.text;
    if (ts.isElementAccessExpression(candidate)) {
      const argument = candidate.argumentExpression;
      if (
        argument &&
        (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument))
      ) {
        return argument.text;
      }
    }
  };
  const isModuleRequire = (expression) => {
    const candidate = unwrapExpression(expression);
    const receiver =
      ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)
        ? unwrapExpression(candidate.expression)
        : undefined;
    if (
      (!ts.isPropertyAccessExpression(candidate) && !ts.isElementAccessExpression(candidate)) ||
      !receiver ||
      !ts.isIdentifier(receiver) ||
      staticMemberName(candidate) !== "require"
    ) {
      return false;
    }
    return kindFor(receiver) === "cjs-module" || isUnshadowedBuiltin(receiver, "module");
  };
  const isGlobalRequire = (expression) => {
    const candidate = unwrapExpression(expression);
    if (!ts.isIdentifier(candidate)) return false;
    return kindFor(candidate) === "loader" || isUnshadowedBuiltin(candidate, "require");
  };
  const isModuleRequireCall = (expression) => {
    if (!expression) return false;
    const candidate = unwrapExpression(expression);
    return (
      ts.isCallExpression(candidate) &&
      (isGlobalRequire(candidate.expression) || isModuleRequire(candidate.expression)) &&
      candidate.arguments.some(isNodeModule)
    );
  };
  const isAwaitedNodeModuleImport = (expression) => {
    if (!expression) return false;
    const candidate = unwrapExpression(expression);
    if (!ts.isAwaitExpression(candidate)) return false;
    const importedModule = unwrapExpression(candidate.expression);
    return (
      ts.isCallExpression(importedModule) &&
      importedModule.expression.kind === ts.SyntaxKind.ImportKeyword &&
      importedModule.arguments.some(isNodeModule)
    );
  };
  const isNodeModuleApiLoad = (expression) =>
    isModuleRequireCall(expression) ||
    isAwaitedNodeModuleImport(expression) ||
    isProcessGetBuiltinModuleCall(expression);
  const isModuleNamespaceReference = (expression) => {
    if (!expression) return false;
    const candidate = unwrapExpression(expression);
    if (ts.isIdentifier(candidate)) return kindFor(candidate) === "module";
    if (
      (ts.isPropertyAccessExpression(candidate) || ts.isElementAccessExpression(candidate)) &&
      staticMemberName(candidate) === "default"
    ) {
      return isModuleNamespaceReference(candidate.expression);
    }
    return isNodeModuleApiLoad(candidate);
  };
  const isCjsModuleObjectReference = (expression) => {
    if (!expression) return false;
    const candidate = unwrapExpression(expression);
    return (
      ts.isIdentifier(candidate) &&
      (kindFor(candidate) === "cjs-module" || isUnshadowedBuiltin(candidate, "module"))
    );
  };
  const isTrackedModuleReference = (expression) =>
    isModuleNamespaceReference(expression) || isCjsModuleObjectReference(expression);
  const isFactoryReference = (expression) => {
    const candidate = unwrapExpression(expression);
    if (ts.isIdentifier(candidate)) return kindFor(candidate) === "factory";
    if (
      (!ts.isPropertyAccessExpression(candidate) && !ts.isElementAccessExpression(candidate)) ||
      staticMemberName(candidate) !== "createRequire"
    ) {
      return false;
    }
    const receiver = unwrapExpression(candidate.expression);
    return isModuleNamespaceReference(receiver);
  };
  const isLoaderReference = (expression) => {
    const candidate = unwrapExpression(expression);
    if (ts.isIdentifier(candidate)) {
      const kind = kindFor(candidate);
      return kind === "loader" || isUnshadowedBuiltin(candidate, "require");
    }
    if (ts.isCallExpression(candidate) && isFactoryReference(candidate.expression)) return true;
    return isModuleRequire(candidate);
  };
  const isImportMetaReference = (expression) => {
    const candidate = unwrapExpression(expression);
    return (
      ts.isMetaProperty(candidate) &&
      candidate.keywordToken === ts.SyntaxKind.ImportKeyword &&
      candidate.name.text === "meta"
    );
  };
  const isModuleResolutionCall = (call) => {
    const callee = unwrapExpression(call.expression);
    return (
      (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) &&
      staticMemberName(callee) === "resolve" &&
      (isLoaderReference(callee.expression) || isImportMetaReference(callee.expression))
    );
  };
  const destructuredModuleBindingKind = (declaration, bindingElement) => {
    const propertyName = bindingElement.propertyName ?? bindingElement.name;
    const propertyNameText =
      ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)
        ? propertyName.text
        : undefined;
    if (!propertyNameText) return undefined;
    if (propertyNameText === "require" && isCjsModuleObjectReference(declaration.initializer)) {
      return "loader";
    }
    if (!isModuleNamespaceReference(declaration.initializer)) return undefined;
    if (propertyNameText === "createRequire") return "factory";
    if (propertyNameText === "default") return "module";
  };
  const initializerKind = (declaration) => {
    const initializer = declaration.initializer;
    if (!initializer) return undefined;

    if (ts.isObjectBindingPattern(declaration.name) && isTrackedModuleReference(initializer)) {
      for (const element of declaration.name.elements) {
        const kind = destructuredModuleBindingKind(declaration, element);
        if (kind) bind(element.name, kind);
      }
      return undefined;
    }
    if (!ts.isIdentifier(declaration.name)) return undefined;

    const identifierInitializer = unwrapExpression(initializer);
    if (
      ts.isIdentifier(identifierInitializer) &&
      isUnshadowedBuiltin(identifierInitializer, "module")
    ) {
      return "cjs-module";
    }
    if (
      ts.isIdentifier(identifierInitializer) &&
      isUnshadowedBuiltin(identifierInitializer, "process")
    ) {
      return "process";
    }
    if (
      ts.isCallExpression(unwrapExpression(initializer)) &&
      isFactoryReference(unwrapExpression(initializer).expression)
    ) {
      return "loader";
    }
    if (isModuleNamespaceReference(initializer)) return "module";
    if (isFactoryReference(initializer)) return "factory";
    if (isLoaderReference(initializer)) return "loader";
    if (ts.isIdentifier(unwrapExpression(initializer))) {
      return kindFor(unwrapExpression(initializer));
    }
    if (isCjsModuleObjectReference(initializer)) return "cjs-module";
  };

  const visitBindings = (node) => {
    if (ts.isImportDeclaration(node) && isNodeModule(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name) bind(clause.name, "module");
      if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        bind(clause.namedBindings.name, "module");
      } else if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const specifier of clause.namedBindings.elements) {
          const importedName = specifier.propertyName?.text ?? specifier.name.text;
          if (importedName === "createRequire") bind(specifier.name, "factory");
          else if (importedName === "default") bind(specifier.name, "module");
        }
      }
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      isNodeModule(node.moduleReference.expression)
    ) {
      bind(node.name, "module");
    }
    if (ts.isVariableDeclaration(node)) declarations.push(node);
    ts.forEachChild(node, visitBindings);
  };
  visitBindings(analysisFile);

  const references = [
    ...(analysisFile.referencedFiles ?? []),
    ...(analysisFile.typeReferenceDirectives ?? []),
  ].sort((left, right) => left.pos - right.pos);
  for (const reference of references) {
    specifiers.push({
      specifier: reference.fileName,
      offset: reference.pos,
      isReferenceDirective: true,
    });
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const declaration of declarations) {
      if (ts.isIdentifier(declaration.name)) {
        const kind = initializerKind(declaration);
        if (kind) changed = bind(declaration.name, kind) || changed;
      } else if (
        ts.isObjectBindingPattern(declaration.name) &&
        isTrackedModuleReference(declaration.initializer)
      ) {
        for (const element of declaration.name.elements) {
          const kind = destructuredModuleBindingKind(declaration, element);
          if (kind) changed = bind(element.name, kind) || changed;
        }
      }
    }
  }

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
      const isModuleCall =
        node.expression.kind === ts.SyntaxKind.ImportKeyword || isLoaderReference(node.expression);
      if (isModuleCall || isModuleResolutionCall(node)) {
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

  visit(analysisFile);
  return specifiers;
};

const collectTypeScriptConfigs = (workspace, workspaces) => {
  const configs = [];
  const visit = (directory) => {
    for (const entry of readDirectoryEntries(directory)) {
      const configPath = join(directory, entry.name);
      if (/^tsconfig(?:\..+)?\.json$/i.test(entry.name)) {
        if (entry.isSymbolicLink()) {
          throw new Error(`TypeScript config symlinks are unsupported: ${configPath}`);
        }
        if (entry.isFile()) configs.push(configPath);
      }
    }
    for (const childPath of childDirectories(directory, { includeHidden: true })) {
      const childWorkspace = workspaceForPath(childPath, workspaces);
      if (childWorkspace && childWorkspace.path !== workspace.path) continue;
      visit(childPath);
    }
  };

  visit(workspace.path);
  return configs.sort((left, right) => left.localeCompare(right));
};

const canonicalFilePath = (path) => {
  const absolutePath = resolve(path);
  return ts.sys.useCaseSensitiveFileNames ? absolutePath : absolutePath.toLowerCase();
};

const getCompilerOptionsForWorkspace = (workspace, workspaces) => {
  const options = [];
  for (const configPath of collectTypeScriptConfigs(workspace, workspaces)) {
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
    options.push({
      path: configPath,
      directory: dirname(configPath),
      options: parsed.options,
      fileNames: new Set(parsed.fileNames.map(canonicalFilePath)),
    });
  }
  return options;
};

const compilerOptionsForSource = (sourcePath, configs) => {
  let applicable = configs.filter((config) => config.fileNames.has(canonicalFilePath(sourcePath)));

  // Scanned files omitted from TypeScript's project roots still use the nearest conventional config.
  // Auxiliary configs such as tsconfig.test.json only apply when their fileNames include the source.
  if (applicable.length === 0) {
    applicable = configs.filter(
      (config) =>
        basename(config.path).toLowerCase() === "tsconfig.json" &&
        isWithinPath(sourcePath, config.directory)
    );
  }

  if (applicable.length === 0) {
    return [{ path: undefined, options: { moduleResolution: ts.ModuleResolutionKind.Node10 } }];
  }

  const nearestDirectoryLength = Math.max(...applicable.map(({ directory }) => directory.length));
  return applicable
    .filter(({ directory }) => directory.length === nearestDirectoryLength)
    .map(({ path, options }) => ({ path, options }));
};

const resolvedWorkspaceTargets = (specifier, containingFile, compilerProjects, workspaces) => {
  const targets = new Set();
  const outcomes = compilerProjects.map(({ path, options }) => {
    const result = ts.resolveModuleName(specifier, containingFile, options, ts.sys);
    const resolvedFileName = result.resolvedModule?.resolvedFileName;
    if (!resolvedFileName) return { path, isResolved: false, target: undefined };

    let canonicalPath;
    try {
      canonicalPath = realpathSync(resolvedFileName);
    } catch (error) {
      if (isMissingPathError(error)) return { path, isResolved: false, target: undefined };
      throw error;
    }
    const target = workspaceForPath(canonicalPath, workspaces);
    if (target) targets.add(target);
    return { path, isResolved: true, target };
  });

  const outcomeNames = new Set(
    outcomes.map(({ isResolved, target }) =>
      !isResolved ? "<unresolved>" : (target?.name ?? "<external>")
    )
  );
  if (outcomeNames.size > 1) {
    const configNames = outcomes.map(({ path }) => path ?? "<default resolution>").join(", ");
    throw new Error(
      `Ambiguous TypeScript module resolution for ${JSON.stringify(specifier)} in ${containingFile} across ${configNames}.`
    );
  }

  return { isResolved: outcomes.some(({ isResolved }) => isResolved), targets };
};

const isDependencyAllowed = (sourceWorkspace, targetWorkspace) => {
  if (sourceWorkspace.name === targetWorkspace.name) return true;
  return (allowedDependencies.get(sourceWorkspace.name) ?? []).includes(targetWorkspace.name);
};

const createViolation = ({ file, kind, source, target, specifier, location }) => ({
  file,
  kind,
  source,
  target,
  specifier,
  ...(location ? { line: location.line, column: location.column } : {}),
  message: location
    ? `${file}:${location.line}:${location.column}: ${source} may not depend on ${target} through ${specifier}`
    : `${file}: ${source} may not depend on ${target} through ${specifier}`,
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

    const workspaceConfigs = getCompilerOptionsForWorkspace(workspace, workspaces);
    for (const filePath of collectSourceFiles(workspace, workspaces)) {
      const fileName = relative(root, filePath).split(sep).join("/");
      const compilerOptions = compilerOptionsForSource(filePath, workspaceConfigs);
      const { contents, units } = sourceTextsForFile(filePath);
      for (const unit of units) {
        const sourceFile = ts.createSourceFile(
          filePath,
          unit.text,
          ts.ScriptTarget.Latest,
          true,
          sourceKindForFile(filePath)
        );
        for (const { specifier, node, offset, isReferenceDirective } of getModuleSpecifiers(
          sourceFile
        )) {
          const analysisOffset = offset ?? node.getStart(sourceFile);
          const location = sourceLocation(contents, unit.sourceOffsetAt(analysisOffset));
          if (specifier === undefined) {
            violations.push({
              file: fileName,
              kind: "unresolved-import",
              source: workspace.name,
              target: "<unresolved>",
              specifier: "<non-literal module call>",
              message: `${fileName}:${location.line}:${location.column}: module call must use a statically resolvable string literal`,
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
                  location: isReferenceDirective ? location : undefined,
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
