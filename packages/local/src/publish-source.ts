import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  BUNDLE_HEADER_BYTES,
  createBundleHeader,
  encodeBundleManifest,
  V1_MAX_BUNDLE_FILES,
  V1_MAX_HTML_SIZE_BYTES,
  validateBundlePath,
  validateSourceFileExtension,
  validateSourceFileSize,
} from "@planview/core";

const NO_FOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);

type SourceEntry = Readonly<{
  readonly path: string;
  readonly absolutePath: string;
  readonly size: number;
  readonly snapshot: Awaited<ReturnType<typeof lstat>>;
}>;

export type PreparedPublishSource = Readonly<{
  readonly sourcePath: string;
  readonly sourceSizeBytes: number;
  readonly cleanup: () => Promise<void>;
}>;

const sameSource = (before: Awaited<ReturnType<typeof lstat>>, after: typeof before) =>
  before.isFile() &&
  after.isFile() &&
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeMs === after.mtimeMs &&
  before.ctimeMs === after.ctimeMs;

const withinRoot = async (root: string, path: string) => {
  const resolved = await realpath(path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`))
    throw new Error("Page folder changed during preparation.");
};

type DirectorySnapshot = { path: string; stats: Awaited<ReturnType<typeof lstat>> };
const sameDirectory = (left: Awaited<ReturnType<typeof lstat>>, right: typeof left) =>
  left.isDirectory() &&
  right.isDirectory() &&
  !right.isSymbolicLink() &&
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const collectEntries = async (
  root: string,
  resolvedRoot: string,
  snapshots: DirectorySnapshot[],
  directory = root
): Promise<SourceEntry[]> => {
  await withinRoot(resolvedRoot, directory);
  const before = await lstat(directory);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw new Error("Page folder changed during preparation.");
  // Windows does not support opening directories through fs.open. The path,
  // resolved-root, and captured identity checks still fence preparation there.
  const directoryHandle =
    process.platform === "win32"
      ? null
      : await open(directory, constants.O_RDONLY | NO_FOLLOW | (constants.O_DIRECTORY ?? 0));
  try {
    if (
      !sameDirectory(
        before,
        directoryHandle ? await directoryHandle.stat() : await lstat(directory)
      )
    )
      throw new Error("Page folder changed during preparation.");
    snapshots.push({ path: directory, stats: before });
    const entries: SourceEntry[] = [];
    const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const child of children) {
      const absolutePath = join(directory, child.name);
      const relativePath = relative(root, absolutePath).split(sep).join("/");
      const stats = await lstat(absolutePath);
      if (stats.isSymbolicLink())
        throw new Error(`Page folders must not contain symbolic links: ${relativePath}.`);
      await withinRoot(resolvedRoot, absolutePath);
      if (stats.isDirectory()) {
        entries.push(...(await collectEntries(root, resolvedRoot, snapshots, absolutePath)));
      } else {
        if (!stats.isFile())
          throw new Error(`Page folders may contain only regular files: ${relativePath}.`);
        validateBundlePath(relativePath);
        entries.push({ path: relativePath, absolutePath, size: stats.size, snapshot: stats });
      }
      if (entries.length > V1_MAX_BUNDLE_FILES)
        throw new Error(`Page folders may contain at most ${V1_MAX_BUNDLE_FILES} files.`);
    }
    if (!sameDirectory(before, await lstat(directory)))
      throw new Error("Page folder changed during preparation.");
    return entries;
  } finally {
    await directoryHandle?.close();
  }
};

const readEntry = async (entry: SourceEntry, maxBytes: number, root: string) => {
  await withinRoot(root, entry.absolutePath);
  const before = await lstat(entry.absolutePath);
  if (!before.isFile() || before.isSymbolicLink() || !sameSource(entry.snapshot, before)) {
    throw new Error(`Page folder entry is no longer a regular file: ${entry.path}.`);
  }
  if (before.size > maxBytes) throw new Error("Page folder exceeds its byte limit.");
  const file = await open(
    entry.absolutePath,
    constants.O_RDONLY | NO_FOLLOW | (constants.O_NONBLOCK ?? 0)
  );
  try {
    const opened = await file.stat();
    if (!sameSource(before, opened))
      throw new Error(`Page folder entry changed while it was being opened: ${entry.path}.`);
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > before.size)
      throw new Error(`Page folder entry grew while it was being read: ${entry.path}.`);
    const contents = Buffer.from(buffer.subarray(0, length));
    await withinRoot(root, entry.absolutePath);
    const after = await lstat(entry.absolutePath);
    if (!sameSource(before, after)) {
      throw new Error(`Page folder entry changed while it was being read: ${entry.path}.`);
    }
    return contents;
  } finally {
    await file.close();
  }
};

const prepareBundle = async (root: string, maxBytes: number): Promise<PreparedPublishSource> => {
  const resolvedRoot = await realpath(root);
  const snapshots: DirectorySnapshot[] = [];
  const entries = await collectEntries(root, resolvedRoot, snapshots);
  if (!entries.some((entry) => entry.path === "index.html")) {
    throw new Error("Page folders must contain a root index.html file.");
  }
  const sourceBytes = entries.reduce((total, entry) => total + entry.size, 0);
  validateSourceFileSize(sourceBytes);
  if (sourceBytes > maxBytes) throw new Error("Page folder exceeds its byte limit.");

  let collectedBytes = 0;
  const files: Array<SourceEntry & { readonly contents: Buffer }> = [];
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    const contents = await readEntry(entry, maxBytes - collectedBytes, resolvedRoot);
    collectedBytes += contents.byteLength;
    files.push({ ...entry, contents });
  }
  for (const snapshot of snapshots) {
    await withinRoot(resolvedRoot, snapshot.path);
    if (!sameDirectory(snapshot.stats, await lstat(snapshot.path)))
      throw new Error("Page folder changed during preparation.");
  }
  let offset = 0;
  const manifestEntries = files.map((file) => {
    const manifestEntry = { path: file.path, offset, size: file.contents.byteLength };
    offset += file.contents.byteLength;
    return manifestEntry;
  });
  const manifest = encodeBundleManifest(manifestEntries);
  const header = createBundleHeader(manifest);
  const totalSize = BUNDLE_HEADER_BYTES + manifest.byteLength + offset;
  validateSourceFileSize(totalSize);
  if (totalSize > maxBytes)
    throw new Error("Page folder exceeds its byte limit including its manifest.");

  const bundle = Buffer.alloc(totalSize);
  Buffer.from(header).copy(bundle, 0);
  Buffer.from(manifest).copy(bundle, BUNDLE_HEADER_BYTES);
  let dataOffset = BUNDLE_HEADER_BYTES + manifest.byteLength;
  for (const file of files) {
    file.contents.copy(bundle, dataOffset);
    dataOffset += file.contents.byteLength;
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "planview-bundle-"));
  const temporaryPath = join(temporaryDirectory, "bundle.html");
  try {
    await writeFile(temporaryPath, bundle, { mode: 0o600 });
  } catch (cause) {
    await rm(temporaryDirectory, { force: true, recursive: true });
    throw cause;
  }
  return {
    sourcePath: temporaryPath,
    sourceSizeBytes: bundle.byteLength,
    cleanup: () => rm(temporaryDirectory, { force: true, recursive: true }),
  };
};

export const preparePublishSource = async (
  inputPath: string,
  options: { maxBytes?: number } = {}
): Promise<PreparedPublishSource> => {
  const maxBytes = options.maxBytes ?? V1_MAX_HTML_SIZE_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > V1_MAX_HTML_SIZE_BYTES)
    throw new Error("Invalid page folder byte limit.");
  const absolutePath = resolve(inputPath);
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`The source must not be a symbolic link: ${inputPath}.`);
  }
  if (stats.isDirectory()) {
    return prepareBundle(absolutePath, maxBytes);
  }
  if (!stats.isFile()) {
    throw new Error(`The source must be a regular HTML file or a page folder: ${inputPath}.`);
  }
  validateSourceFileExtension(inputPath);
  validateSourceFileSize(stats.size);
  return {
    sourcePath: absolutePath,
    sourceSizeBytes: stats.size,
    cleanup: async () => {},
  };
};
