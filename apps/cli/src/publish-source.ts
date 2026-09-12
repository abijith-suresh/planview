import { constants } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  BUNDLE_HEADER_BYTES,
  createBundleHeader,
  encodeBundleManifest,
  V1_MAX_BUNDLE_FILES,
  validateBundlePath,
  validateSourceFileExtension,
  validateSourceFileSize,
} from "@planview/core";

const NO_FOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);

type SourceEntry = Readonly<{
  readonly path: string;
  readonly absolutePath: string;
  readonly size: number;
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

const collectEntries = async (root: string, directory = root): Promise<SourceEntry[]> => {
  const entries: SourceEntry[] = [];
  const children = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
    left.name.localeCompare(right.name)
  );
  for (const child of children) {
    const absolutePath = join(directory, child.name);
    const relativePath = relative(root, absolutePath).split(sep).join("/");
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw new Error(`Page folders must not contain symbolic links: ${relativePath}.`);
    }
    if (stats.isDirectory()) {
      entries.push(...(await collectEntries(root, absolutePath)));
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`Page folders may contain only regular files: ${relativePath}.`);
    }
    validateBundlePath(relativePath);
    entries.push({ path: relativePath, absolutePath, size: stats.size });
    if (entries.length > V1_MAX_BUNDLE_FILES) {
      throw new Error(`Page folders may contain at most ${V1_MAX_BUNDLE_FILES} files.`);
    }
  }
  return entries;
};

const readEntry = async (entry: SourceEntry) => {
  const before = await lstat(entry.absolutePath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(`Page folder entry is no longer a regular file: ${entry.path}.`);
  }
  const file = await open(entry.absolutePath, constants.O_RDONLY | NO_FOLLOW);
  try {
    const contents = await file.readFile();
    const after = await lstat(entry.absolutePath);
    if (!sameSource(before, after)) {
      throw new Error(`Page folder entry changed while it was being read: ${entry.path}.`);
    }
    return contents;
  } finally {
    await file.close();
  }
};

const prepareBundle = async (root: string): Promise<PreparedPublishSource> => {
  const entries = await collectEntries(root);
  if (!entries.some((entry) => entry.path === "index.html")) {
    throw new Error("Page folders must contain a root index.html file.");
  }
  const sourceBytes = entries.reduce((total, entry) => total + entry.size, 0);
  validateSourceFileSize(sourceBytes);

  const files: Array<SourceEntry & { readonly contents: Buffer }> = [];
  for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
    files.push({ ...entry, contents: await readEntry(entry) });
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

export const preparePublishSource = async (inputPath: string): Promise<PreparedPublishSource> => {
  const absolutePath = resolve(inputPath);
  const stats = await lstat(absolutePath);
  if (stats.isSymbolicLink()) {
    throw new Error(`The source must not be a symbolic link: ${inputPath}.`);
  }
  if (stats.isDirectory()) {
    return prepareBundle(absolutePath);
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
