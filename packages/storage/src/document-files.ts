import { randomBytes as cryptoRandomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { hostname } from "node:os";
import { link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
import type { ReadStream } from "node:fs";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  InvalidSourceFileSizeError,
  SourceFileTooLargeError,
  UnsupportedSourceExtensionError,
  V1_MAX_HTML_SIZE_BYTES,
  validateDocumentId,
  validateSourceFileExtension,
  validateSourceFileSize,
} from "@planview/core";
import { Data, Effect } from "effect";

const MAX_STAGED_HANDLE_BYTES = 32;
const MAX_STAGED_ALLOCATION_ATTEMPTS = 128;
const STAGED_HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
const NON_BLOCKING = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0);
const DIRECTORY = constants.O_DIRECTORY ?? 0;
// fsync(2) reports EINVAL for a directory on filesystems that do not implement
// directory synchronization. The remaining codes are explicit unsupported
// responses. EBADF, ENOTDIR, and all other errors are operational failures.
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set(["EINVAL", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"]);
const USE_DIRECTORY_FDS =
  process.platform === "linux" && DIRECTORY !== 0 && existsSync("/proc/self/fd");
const FINALIZATION_LOCK_METADATA_NAME = "owner.json";
const FINALIZATION_LOCK_METADATA_BYTES = 4 * 1024;
const FINALIZATION_LOCK_LEASE_MS = 30_000;
const FINALIZATION_LOCK_RECOVERY_GRACE_MS = 5_000;
const FINALIZATION_LOCK_OWNER_TOKEN_BYTES = 16;
const LOCAL_HOSTNAME = hostname();

class FinalizationLockBusyError extends Error {}

type FileIdentity = Pick<Stats, "dev" | "ino" | "birthtimeMs">;

type TrustedDirectory = {
  readonly path: string;
  readonly identity: FileIdentity;
  readonly fd: number | undefined;
};

type FinalizationLockMetadata = {
  readonly version: 1;
  readonly owner: {
    readonly pid: number;
    readonly host: string;
    readonly token: string;
  };
  readonly acquiredAt: number;
  readonly leaseExpiresAt: number;
};

export type DocumentFileStoreOptions = {
  readonly documentsDir: string;
  readonly stagingDir: string;
  readonly randomBytes?: (size: number) => Uint8Array;
};

declare const stagedDocumentFileHandleBrand: unique symbol;

/** A random capability naming one file in the private staging directory. */
export type StagedDocumentFileHandle = string & {
  readonly [stagedDocumentFileHandleBrand]: "StagedDocumentFileHandle";
};

export class DocumentFileStorePathError extends Data.TaggedError("DocumentFileStorePathError")<{
  readonly path: string;
  readonly reason: string;
  readonly message: string;
}> {}

export class DocumentFileStoreOpenError extends Data.TaggedError("DocumentFileStoreOpenError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class DocumentFileStoreClosedError extends Data.TaggedError("DocumentFileStoreClosedError")<{
  readonly message: string;
}> {}

export class DocumentFileSourceError extends Data.TaggedError("DocumentFileSourceError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class DocumentFileNotRegularError extends Data.TaggedError("DocumentFileNotRegularError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class InvalidStagedDocumentFileHandleError extends Data.TaggedError(
  "InvalidStagedDocumentFileHandleError"
)<{
  readonly value: unknown;
  readonly message: string;
}> {}

export class DocumentFileAlreadyExistsError extends Data.TaggedError(
  "DocumentFileAlreadyExistsError"
)<{
  readonly id: string;
  readonly message: string;
}> {}

export class DocumentFileFinalizeError extends Data.TaggedError("DocumentFileFinalizeError")<{
  readonly id: string;
  readonly handle: string;
  readonly cause: unknown;
  readonly cleanupCause?: unknown;
  readonly message: string;
}> {}

export class DocumentFileReadError extends Data.TaggedError("DocumentFileReadError")<{
  readonly id: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class DocumentFileDeleteError extends Data.TaggedError("DocumentFileDeleteError")<{
  readonly id: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export interface DocumentFileStore {
  /** Requests closure and resolves after all already-started operations release their leases. */
  readonly close: () => Promise<void>;
  readonly stageSourceFile: (sourcePath: string) => Promise<StagedDocumentFileHandle>;
  readonly finalizeStagedFile: (handle: StagedDocumentFileHandle, id: string) => Promise<void>;
  readonly readDocument: (id: string) => Promise<ReadStream>;
  readonly readDocumentFile: (id: string) => Promise<ReadStream>;
  readonly deleteDocumentFile: (id: string) => Promise<boolean>;
}

const isFileStoreError = (error: unknown) =>
  error instanceof DocumentFileStorePathError ||
  error instanceof DocumentFileStoreOpenError ||
  error instanceof DocumentFileStoreClosedError ||
  error instanceof DocumentFileSourceError ||
  error instanceof DocumentFileNotRegularError ||
  error instanceof InvalidStagedDocumentFileHandleError ||
  error instanceof DocumentFileAlreadyExistsError ||
  error instanceof DocumentFileFinalizeError ||
  error instanceof DocumentFileReadError ||
  error instanceof DocumentFileDeleteError;

const errorCode = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
};

const isNotFound = (error: unknown) => errorCode(error) === "ENOENT";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const validateDirectoryPath = (path: unknown, label: string) => {
  if (typeof path !== "string" || path.length === 0 || !isAbsolute(path)) {
    throw new DocumentFileStorePathError({
      path: typeof path === "string" ? path : String(path),
      reason: `${label} must be a non-empty absolute path.`,
      message: `Could not initialize document file storage: ${label} must be a non-empty absolute path.`,
    });
  }

  const normalized = resolve(path);
  if (normalized === parse(normalized).root) {
    throw new DocumentFileStorePathError({
      path,
      reason: `${label} must not be a filesystem root.`,
      message: `Could not initialize document file storage: ${label} must not be a filesystem root.`,
    });
  }
  return normalized;
};

const pathKey = (path: string) => {
  let normalized = normalize(path);
  if (process.platform === "win32") {
    if (normalized.startsWith("\\\\?\\UNC\\")) {
      normalized = `\\\\${normalized.slice("\\\\?\\UNC\\".length)}`;
    } else if (normalized.startsWith("\\\\?\\")) {
      normalized = normalized.slice("\\\\?\\".length);
    }
    return normalized.toLowerCase();
  }
  return normalized;
};

const canonicalPath = (path: string) => pathKey(realpathSync.native(path));

const samePath = (left: string, right: string) => pathKey(left) === pathKey(right);

const sameFileIdentity = (left: FileIdentity, right: FileIdentity) => {
  if (left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0) {
    return left.dev === right.dev && left.ino === right.ino;
  }
  return left.birthtimeMs === right.birthtimeMs;
};

const pathError = (path: string, reason: string) =>
  new DocumentFileStorePathError({
    path,
    reason,
    message: `Could not use document file storage path ${path}: ${reason}`,
  });

const checkAncestorSecurity = (path: string, stats: Stats, final: boolean) => {
  if (process.platform === "win32") {
    // Node does not expose a portable NTFS ACL or reparse-point inspection API.
    // The Windows branch is intentionally a local-trust check, not a privacy or
    // containment assertion.
    return;
  }

  const mode = stats.mode & 0o7777;
  if (final) {
    const uid = process.getuid?.();
    if (uid !== undefined && stats.uid !== uid) {
      throw pathError(path, "the storage directory must be owned by the current user.");
    }
    return;
  }

  const writableByOthers = mode & 0o022;
  const safeStickyDirectory = (mode & 0o1000) !== 0 && (mode & 0o0002) !== 0;
  if (writableByOthers !== 0 && !safeStickyDirectory) {
    throw pathError(path, "a storage parent directory is writable by group or others.");
  }
};

const pathSegments = (path: string) => {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const remainder = relative(root, absolute);
  return {
    root,
    segments: remainder.split(sep).filter((segment) => segment.length > 0),
  };
};

const makePrivateDirectory = (path: string) => {
  try {
    const { root, segments } = pathSegments(path);
    let current = root;
    for (const [index, segment] of segments.entries()) {
      current = join(current, segment);
      try {
        const stats = lstatSync(current);
        if (stats.isSymbolicLink()) {
          throw pathError(current, "storage paths and their parents must not be symbolic links.");
        }
        if (!stats.isDirectory()) {
          throw pathError(current, "every storage path component must be a directory.");
        }
        checkAncestorSecurity(current, stats, index === segments.length - 1);
      } catch (cause) {
        if (errorCode(cause) !== "ENOENT") {
          throw cause;
        }
        mkdirSync(current, { mode: PRIVATE_DIRECTORY_MODE });
        const created = lstatSync(current);
        if (!created.isDirectory() || created.isSymbolicLink()) {
          throw pathError(current, "the storage directory was replaced while it was created.");
        }
        checkAncestorSecurity(current, created, index === segments.length - 1);
      }
    }

    const realPath = canonicalPath(path);
    if (!samePath(realPath, path)) {
      throw pathError(path, "storage paths and their parents must resolve without symlinks.");
    }

    if (process.platform !== "win32") {
      chmodSync(path, PRIVATE_DIRECTORY_MODE);
      const privateStats = lstatSync(path);
      checkAncestorSecurity(path, privateStats, true);
      if ((privateStats.mode & 0o077) !== 0) {
        throw pathError(path, "the storage directory must not be accessible by group or others.");
      }
    }
  } catch (cause) {
    if (cause instanceof DocumentFileStorePathError) {
      throw cause;
    }
    throw new DocumentFileStoreOpenError({
      path,
      cause,
      message: `Could not initialize document file storage directory ${path}: ${describe(cause)}`,
    });
  }
};

const openTrustedDirectory = (path: string) => {
  try {
    const stats = lstatSync(path);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw pathError(path, "the storage directory must be a real directory.");
    }
    const expectedPath = canonicalPath(path);
    if (!samePath(expectedPath, path)) {
      throw pathError(path, "storage paths and their parents must resolve without symlinks.");
    }

    let fd: number | undefined;
    if (USE_DIRECTORY_FDS) {
      try {
        fd = openSync(path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
        const opened = fstatSync(fd);
        if (!sameFileIdentity(stats, opened)) {
          throw pathError(path, "the storage directory changed while it was opened.");
        }
        if (!samePath(canonicalPath(path), path)) {
          throw pathError(path, "storage paths and their parents must resolve without symlinks.");
        }
      } catch (cause) {
        if (fd !== undefined) {
          closeSync(fd);
          fd = undefined;
        }
        throw cause;
      }
    }

    return { path, identity: stats, fd } satisfies TrustedDirectory;
  } catch (cause) {
    if (cause instanceof DocumentFileStorePathError) {
      throw cause;
    }
    throw new DocumentFileStoreOpenError({
      path,
      cause,
      message: `Could not open trusted document file storage directory ${path}: ${describe(cause)}`,
    });
  }
};

const verifyTrustedDirectory = (directory: TrustedDirectory) => {
  const { root, segments } = pathSegments(directory.path);
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch (cause) {
      throw pathError(directory.path, `a trusted storage path disappeared: ${describe(cause)}`);
    }
    if (stats.isSymbolicLink()) {
      throw pathError(
        directory.path,
        "storage paths and their parents must not be symbolic links."
      );
    }
    if (!stats.isDirectory()) {
      throw pathError(directory.path, "a trusted storage path component is not a directory.");
    }
    checkAncestorSecurity(current, stats, index === segments.length - 1);
  }

  if (!samePath(canonicalPath(directory.path), directory.path)) {
    throw pathError(
      directory.path,
      "storage paths and their parents must resolve without symlinks."
    );
  }
  const stats = lstatSync(directory.path);
  if (!sameFileIdentity(directory.identity, stats)) {
    throw pathError(directory.path, "the trusted storage directory was replaced.");
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw pathError(directory.path, "the storage directory permissions are no longer private.");
  }
};

const closeTrustedDirectory = (directory: TrustedDirectory) => {
  if (directory.fd !== undefined) {
    try {
      closeSync(directory.fd);
    } catch {
      // close() is deliberately synchronous and best effort.
    }
  }
};

const isDirectorySyncUnsupported = (cause: unknown) =>
  DIRECTORY_SYNC_UNSUPPORTED_CODES.has(errorCode(cause) ?? "");

const syncDirectory = async (directory: TrustedDirectory) => {
  if (directory.fd !== undefined) {
    try {
      fsyncSync(directory.fd);
    } catch (cause) {
      if (!isDirectorySyncUnsupported(cause)) {
        throw cause;
      }
    }
    return;
  }

  // Windows has no Node API for opening a directory handle suitable for fsync.
  if (process.platform === "win32") {
    return;
  }

  // Keep opening the directory outside the unsupported-error filter. An open
  // failure means the trusted directory cannot be used, not that directory
  // synchronization is unavailable.
  const handle = await open(directory.path, constants.O_RDONLY | DIRECTORY | NO_FOLLOW);
  try {
    try {
      await handle.sync();
    } catch (cause) {
      if (!isDirectorySyncUnsupported(cause)) {
        throw cause;
      }
    }
  } finally {
    await handle.close();
  }
};

const isValidStagedHandle = (value: unknown): value is StagedDocumentFileHandle =>
  typeof value === "string" && STAGED_HANDLE_PATTERN.test(value);

const validateStagedHandle = (value: unknown) => {
  if (!isValidStagedHandle(value)) {
    throw new InvalidStagedDocumentFileHandleError({
      value,
      message: "The staged document file handle is not a valid opaque handle.",
    });
  }

  return value;
};

const sourceValidationError = (error: unknown) =>
  error instanceof UnsupportedSourceExtensionError ||
  error instanceof InvalidSourceFileSizeError ||
  error instanceof SourceFileTooLargeError;

const createStagedHandle = (randomBytes: (size: number) => Uint8Array) => {
  const bytes = randomBytes(MAX_STAGED_HANDLE_BYTES);
  if (!(bytes instanceof Uint8Array) || bytes.length < MAX_STAGED_HANDLE_BYTES) {
    throw new Error("The staged-file random source returned too few bytes.");
  }

  const handle = Buffer.from(bytes.subarray(0, MAX_STAGED_HANDLE_BYTES)).toString("base64url");
  return validateStagedHandle(handle);
};

const validateNoSymlinkAncestors = async (path: string) => {
  const { root, segments } = pathSegments(path);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    let stats: Stats;
    try {
      stats = await lstat(current);
    } catch (cause) {
      if (isNotFound(cause)) {
        return;
      }
      throw cause;
    }
    if (stats.isSymbolicLink()) {
      throw new DocumentFileNotRegularError({
        path,
        message: `The document source path must not contain symbolic links: ${path}.`,
      });
    }
    // On Windows, lstat cannot prove that a non-symbolic-link directory is not
    // a junction or another reparse point. The final open/identity checks remain
    // useful, but callers must not treat this walk as absolute containment.
  }
};

const regularFileError = (path: string) =>
  new DocumentFileNotRegularError({
    path,
    message: `The document file must be a regular file and must not be a symbolic link: ${path}.`,
  });

const openWithoutFollowingLinks = async (
  path: string,
  flags: number,
  displayPath = path,
  checkAncestors = true
) => {
  if (checkAncestors) {
    await validateNoSymlinkAncestors(path);
  }

  const beforeOpen = await lstat(path);
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
    throw regularFileError(displayPath);
  }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NONBLOCK makes the check safe if a regular file is replaced by a FIFO/device
    // between lstat() and open(). O_NOFOLLOW is available on Unix; the post-open
    // identity checks are the safe Node-only fallback on Windows.
    file = await open(path, flags | NO_FOLLOW | NON_BLOCKING);
    const opened = await file.stat();
    if (!opened.isFile() || opened.isSymbolicLink()) {
      throw regularFileError(displayPath);
    }
    if (!sameFileIdentity(beforeOpen, opened)) {
      throw new Error("The file changed while it was being opened.");
    }

    const afterOpen = await lstat(path);
    if (!afterOpen.isFile() || afterOpen.isSymbolicLink()) {
      throw new Error("The file changed to a non-regular file while it was being opened.");
    }
    if (!sameFileIdentity(opened, afterOpen)) {
      throw new Error("The file changed while it was being opened.");
    }
    if (checkAncestors) {
      await validateNoSymlinkAncestors(path);
    }
    return file;
  } catch (cause) {
    await file?.close().catch(() => undefined);
    throw cause;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const readFinalizationLockMetadata = async (lockPath: string) => {
  let lockStats: Stats;
  try {
    lockStats = await lstat(lockPath);
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
  if (!lockStats.isDirectory() || lockStats.isSymbolicLink()) {
    return undefined;
  }

  const metadataPath = join(lockPath, FINALIZATION_LOCK_METADATA_NAME);
  let metadataFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    metadataFile = await openWithoutFollowingLinks(
      metadataPath,
      constants.O_RDONLY,
      metadataPath,
      false
    );
    const contents = Buffer.alloc(FINALIZATION_LOCK_METADATA_BYTES + 1);
    const { bytesRead } = await metadataFile.read(contents, 0, contents.length, 0);
    if (bytesRead > FINALIZATION_LOCK_METADATA_BYTES) {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return undefined;
    }
    if (!isRecord(parsed)) {
      return undefined;
    }
    const { version, owner: ownerValue, acquiredAt, leaseExpiresAt } = parsed;
    if (version !== 1 || !isRecord(ownerValue)) {
      return undefined;
    }
    const { pid, host, token } = ownerValue;
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof host !== "string" ||
      host.length === 0 ||
      typeof token !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(token) ||
      typeof acquiredAt !== "number" ||
      !Number.isSafeInteger(acquiredAt) ||
      typeof leaseExpiresAt !== "number" ||
      !Number.isSafeInteger(leaseExpiresAt) ||
      acquiredAt < 0 ||
      leaseExpiresAt < acquiredAt ||
      leaseExpiresAt - acquiredAt > FINALIZATION_LOCK_LEASE_MS
    ) {
      return undefined;
    }

    return {
      version: 1,
      owner: { pid, host, token },
      acquiredAt,
      leaseExpiresAt,
    } satisfies FinalizationLockMetadata;
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  } finally {
    await metadataFile?.close();
  }
};

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // EPERM means the process exists but cannot be probed. Treat every result
    // other than a definite ESRCH as alive so recovery never guesses.
    return errorCode(cause) !== "ESRCH";
  }
};

const removeFinalizationLockDirectory = async (lockPath: string) => {
  const metadataPath = join(lockPath, FINALIZATION_LOCK_METADATA_NAME);
  try {
    await unlink(metadataPath);
  } catch (cause) {
    if (!isNotFound(cause)) {
      throw cause;
    }
  }
  try {
    await rmdir(lockPath);
  } catch (cause) {
    if (!isNotFound(cause)) {
      throw cause;
    }
  }
};

const recoverStaleFinalizationLock = async (lockPath: string) => {
  const metadata = await readFinalizationLockMetadata(lockPath);
  if (
    metadata === undefined ||
    metadata.owner.host !== LOCAL_HOSTNAME ||
    metadata.leaseExpiresAt > Date.now() - FINALIZATION_LOCK_RECOVERY_GRACE_MS ||
    isProcessAlive(metadata.owner.pid)
  ) {
    return false;
  }

  const quarantinePath = `${lockPath}.recovery-${metadata.owner.token}-${process.pid}-${cryptoRandomBytes(8).toString("hex")}`;
  try {
    // Rename moves precisely the lock directory that was inspected. It avoids
    // the unsafe remove-then-create gap in which another finalizer could win.
    await rename(lockPath, quarantinePath);
  } catch (cause) {
    if (isNotFound(cause)) {
      return false;
    }
    throw cause;
  }

  await removeFinalizationLockDirectory(quarantinePath);
  return true;
};

const createFinalizationLockMetadata = () => {
  const acquiredAt = Date.now();
  return {
    version: 1,
    owner: {
      pid: process.pid,
      host: LOCAL_HOSTNAME,
      token: cryptoRandomBytes(FINALIZATION_LOCK_OWNER_TOKEN_BYTES).toString("base64url"),
    },
    acquiredAt,
    leaseExpiresAt: acquiredAt + FINALIZATION_LOCK_LEASE_MS,
  } satisfies FinalizationLockMetadata;
};

const acquireFinalizationLock = async (lockPath: string) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") {
        throw cause;
      }
      if (attempt === 0) {
        try {
          if (await recoverStaleFinalizationLock(lockPath)) {
            continue;
          }
        } catch {
          // A lock that cannot be inspected or quarantined is retained. Treat it
          // as busy rather than deleting the staged file behind an owner.
        }
      }
      throw new FinalizationLockBusyError("The staged document file is already being finalized.");
    }

    const metadataPath = join(lockPath, FINALIZATION_LOCK_METADATA_NAME);
    const metadata = createFinalizationLockMetadata();
    let metadataFile: Awaited<ReturnType<typeof open>> | undefined;
    try {
      metadataFile = await open(
        metadataPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        PRIVATE_FILE_MODE
      );
      await metadataFile.writeFile(JSON.stringify(metadata), "utf8");
      await metadataFile.sync();
      await metadataFile.close();
      metadataFile = undefined;
    } catch (cause) {
      await metadataFile?.close().catch(() => undefined);
      metadataFile = undefined;
      try {
        await removeFinalizationLockDirectory(lockPath);
      } catch (cleanupCause) {
        throw new Error(
          `Could not initialize finalization lock: ${describe(cause)}; cleanup also failed: ${describe(cleanupCause)}`
        );
      }
      throw cause;
    }
    return;
  }
};

const entryPath = (directory: TrustedDirectory, name: string) =>
  directory.fd === undefined
    ? join(directory.path, name)
    : join(`/proc/self/fd/${directory.fd}`, name);

const targetConflict = (path: string, id: string, stats: Stats) => {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return regularFileError(path);
  }
  return new DocumentFileAlreadyExistsError({
    id,
    message: `A document with id ${id} already exists.`,
  });
};

const assertTargetAbsent = async (path: string, id: string) => {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) {
      return;
    }
    throw cause;
  }
  throw targetConflict(path, id, stats);
};

const classifyTargetCollision = async (path: string, id: string) => {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (cause) {
    throw new Error(`The document target collision could not be inspected: ${describe(cause)}`);
  }
  throw targetConflict(path, id, stats);
};

const createStore = ({
  documentsDir,
  stagingDir,
  randomBytes,
}: {
  readonly documentsDir: TrustedDirectory;
  readonly stagingDir: TrustedDirectory;
  readonly randomBytes?: (size: number) => Uint8Array;
}) => {
  let closeRequested = false;
  let directoriesClosed = false;
  let activeOperations = 0;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  const generateBytes = randomBytes ?? cryptoRandomBytes;

  const ensureOpen = () => {
    if (closeRequested) {
      throw new DocumentFileStoreClosedError({ message: "Document file storage is closed." });
    }
  };

  const finishClose = () => {
    if (closeRequested && activeOperations === 0 && !directoriesClosed) {
      directoriesClosed = true;
      closeTrustedDirectory(documentsDir);
      closeTrustedDirectory(stagingDir);
      resolveClose?.();
      resolveClose = undefined;
    }
  };

  const beginOperation = () => {
    ensureOpen();
    activeOperations += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      activeOperations -= 1;
      finishClose();
    };
  };

  const ensureTrustedRoots = () => {
    verifyTrustedDirectory(documentsDir);
    verifyTrustedDirectory(stagingDir);
  };

  const stagingPath = (handle: unknown) => entryPath(stagingDir, validateStagedHandle(handle));
  const documentPath = (id: string) => entryPath(documentsDir, `${validateDocumentId(id)}.html`);
  const unlinkEntry = async (directory: TrustedDirectory, name: string) => {
    verifyTrustedDirectory(directory);
    await unlink(entryPath(directory, name));
  };
  const close = () => {
    if (closePromise === undefined) {
      closeRequested = true;
      closePromise = new Promise<void>((resolveClosePromise) => {
        resolveClose = resolveClosePromise;
      });
      finishClose();
    }
    return closePromise;
  };

  const stageSourceFile = async (sourcePath: string) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      validateSourceFileExtension(sourcePath);

      const absoluteSourcePath = resolve(sourcePath);
      let source: Awaited<ReturnType<typeof open>> | undefined;
      let staged: Awaited<ReturnType<typeof open>> | undefined;
      let sourceStream: ReadStream | undefined;
      let destinationStream:
        | ReturnType<Awaited<ReturnType<typeof open>>["createWriteStream"]>
        | undefined;
      let handle: StagedDocumentFileHandle | undefined;
      let keepStaged = false;

      try {
        try {
          source = await openWithoutFollowingLinks(
            absoluteSourcePath,
            constants.O_RDONLY,
            sourcePath
          );
        } catch (cause) {
          if (cause instanceof DocumentFileNotRegularError) {
            throw cause;
          }
          throw new DocumentFileSourceError({
            path: sourcePath,
            cause,
            message: `Could not open source document file ${sourcePath}: ${describe(cause)}`,
          });
        }

        const stats = await source.stat();
        validateSourceFileSize(stats.size);

        for (let attempt = 0; attempt < MAX_STAGED_ALLOCATION_ATTEMPTS; attempt += 1) {
          const candidate = createStagedHandle(generateBytes);
          try {
            staged = await open(
              stagingPath(candidate),
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
              PRIVATE_FILE_MODE
            );
            handle = candidate;
            const stagedStats = await staged.stat();
            if (!stagedStats.isFile() || stagedStats.isSymbolicLink()) {
              throw regularFileError(stagingPath(candidate));
            }
            handle = candidate;
            break;
          } catch (cause) {
            if (staged !== undefined) {
              await staged.close().catch(() => undefined);
              staged = undefined;
            }
            if (errorCode(cause) !== "EEXIST") {
              throw cause;
            }
          }
        }

        if (staged === undefined || handle === undefined) {
          throw new Error("Could not allocate a unique staged document file handle.");
        }
        ensureTrustedRoots();

        sourceStream = source.createReadStream({ autoClose: true });
        let copiedBytes = 0;
        const limiter = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            copiedBytes += chunk.byteLength;
            if (copiedBytes > V1_MAX_HTML_SIZE_BYTES) {
              callback(new SourceFileTooLargeError(copiedBytes));
              return;
            }
            callback(null, chunk);
          },
        });
        destinationStream = staged.createWriteStream({ autoClose: true });
        await pipeline(sourceStream, limiter, destinationStream);
        source = undefined;
        staged = undefined;

        const pathAfterRead = await lstat(absoluteSourcePath);
        if (
          pathAfterRead.isSymbolicLink() ||
          !pathAfterRead.isFile() ||
          !sameFileIdentity(stats, pathAfterRead) ||
          copiedBytes !== stats.size ||
          copiedBytes !== pathAfterRead.size
        ) {
          throw new DocumentFileSourceError({
            path: sourcePath,
            cause: new Error("The source changed while it was being staged."),
            message: `Could not stage source document file ${sourcePath}: the source changed while it was being read.`,
          });
        }

        ensureTrustedRoots();
        const durableStaged = await openWithoutFollowingLinks(
          stagingPath(handle),
          constants.O_RDONLY,
          stagingPath(handle),
          false
        );
        try {
          await durableStaged.sync();
        } finally {
          await durableStaged.close().catch(() => undefined);
        }
        await syncDirectory(stagingDir);
        keepStaged = true;
        return handle;
      } catch (cause) {
        sourceStream?.destroy();
        destinationStream?.destroy();
        if (sourceStream !== undefined) {
          source = undefined;
        }
        if (destinationStream !== undefined) {
          staged = undefined;
        }
        await staged?.close().catch(() => undefined);
        staged = undefined;

        let cleanupCause: unknown;
        if (handle !== undefined && !keepStaged) {
          try {
            await unlinkEntry(stagingDir, handle);
          } catch (cleanupError) {
            if (!isNotFound(cleanupError)) {
              cleanupCause = cleanupError;
            }
          }
        }

        if (cleanupCause !== undefined) {
          throw new DocumentFileSourceError({
            path: sourcePath,
            cause,
            message: `Could not stage source document file ${sourcePath}: ${describe(cause)}; cleanup also failed: ${describe(cleanupCause)}`,
          });
        }
        if (
          sourceValidationError(cause) ||
          cause instanceof DocumentFileSourceError ||
          cause instanceof DocumentFileNotRegularError
        ) {
          throw cause;
        }
        throw new DocumentFileSourceError({
          path: sourcePath,
          cause,
          message: `Could not stage source document file ${sourcePath}: ${describe(cause)}`,
        });
      } finally {
        await staged?.close().catch(() => undefined);
        await source?.close().catch(() => undefined);
      }
    } finally {
      releaseOperation();
    }
  };

  const finalizeStagedFile = async (handleValue: StagedDocumentFileHandle, id: string) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const handle = validateStagedHandle(handleValue);
      const documentId = validateDocumentId(id);
      const sourcePath = stagingPath(handle);
      const targetPath = documentPath(documentId);
      const lockPath = entryPath(stagingDir, `.${handle}.lock`);
      let source: Awaited<ReturnType<typeof open>> | undefined;
      let lockOwned = false;
      let anotherFinalizerOwnsLock = false;
      let targetNeedsCleanup = false;
      let targetIdentity: FileIdentity | undefined;
      let cleanupCause: unknown;

      try {
        source = await openWithoutFollowingLinks(sourcePath, constants.O_RDONLY, sourcePath, false);
        const sourceStats = await source.stat();
        validateSourceFileSize(sourceStats.size);

        try {
          await acquireFinalizationLock(lockPath);
          lockOwned = true;
          await syncDirectory(stagingDir);
        } catch (cause) {
          if (cause instanceof FinalizationLockBusyError) {
            anotherFinalizerOwnsLock = true;
          }
          throw cause;
        }

        ensureTrustedRoots();
        await assertTargetAbsent(targetPath, documentId);
        const sourceBeforeLink = await lstat(sourcePath);
        const sourceAtLink = await source.stat();
        if (
          sourceBeforeLink.isSymbolicLink() ||
          !sourceBeforeLink.isFile() ||
          !sameFileIdentity(sourceStats, sourceBeforeLink) ||
          !sameFileIdentity(sourceStats, sourceAtLink) ||
          sourceAtLink.size > V1_MAX_HTML_SIZE_BYTES
        ) {
          throw new Error("The staged document file changed while it was being finalized.");
        }

        ensureTrustedRoots();
        await source.sync();
        try {
          // link() is the Node-supported atomic no-replace primitive. rename() would
          // replace a concurrently-created target on POSIX, so it is intentionally not
          // used here. The source and target must support hard links and share a volume.
          await link(sourcePath, targetPath);
          targetNeedsCleanup = true;
        } catch (cause) {
          if (errorCode(cause) === "EEXIST") {
            await classifyTargetCollision(targetPath, documentId);
          }
          throw cause;
        }

        const targetStats = await lstat(targetPath);
        const sourceAfterLink = await source.stat();
        if (
          targetStats.isSymbolicLink() ||
          !targetStats.isFile() ||
          !sameFileIdentity(targetStats, sourceAfterLink)
        ) {
          throw regularFileError(targetPath);
        }
        targetIdentity = targetStats;

        await syncDirectory(documentsDir);
        targetNeedsCleanup = false;
        await source.close();
        source = undefined;
        await unlinkEntry(stagingDir, handle);
        await removeFinalizationLockDirectory(lockPath);
        lockOwned = false;
        await syncDirectory(stagingDir);
        return;
      } catch (cause) {
        await source?.close().catch((closeError) => {
          cleanupCause ??= closeError;
        });
        source = undefined;

        if (targetNeedsCleanup && !anotherFinalizerOwnsLock) {
          try {
            const targetStats = await lstat(targetPath);
            if (
              targetIdentity === undefined ||
              !targetStats.isFile() ||
              targetStats.isSymbolicLink() ||
              !sameFileIdentity(targetIdentity, targetStats)
            ) {
              throw new Error("The unpublished document target changed before cleanup.");
            }
            await unlinkEntry(documentsDir, `${documentId}.html`);
            targetNeedsCleanup = false;
            try {
              await syncDirectory(documentsDir);
            } catch (targetSyncCleanupError) {
              cleanupCause ??= targetSyncCleanupError;
            }
          } catch (targetCleanupError) {
            if (isNotFound(targetCleanupError)) {
              targetNeedsCleanup = false;
            } else {
              cleanupCause ??= targetCleanupError;
            }
          }
        }

        if (lockOwned) {
          try {
            await unlinkEntry(stagingDir, handle);
          } catch (sourceCleanupError) {
            if (!isNotFound(sourceCleanupError)) {
              cleanupCause ??= sourceCleanupError;
            }
          }
          try {
            await removeFinalizationLockDirectory(lockPath);
            lockOwned = false;
          } catch (lockCleanupError) {
            if (!isNotFound(lockCleanupError)) {
              cleanupCause ??= lockCleanupError;
            }
          }
        } else if (!anotherFinalizerOwnsLock) {
          // If opening the staged file failed before the lock was acquired, removing
          // this opaque handle is still safe: unlink() never follows a symlink.
          try {
            await unlinkEntry(stagingDir, handle);
          } catch (sourceCleanupError) {
            if (!isNotFound(sourceCleanupError)) {
              cleanupCause ??= sourceCleanupError;
            }
          }
        }

        if (
          cleanupCause === undefined &&
          (cause instanceof DocumentFileAlreadyExistsError ||
            cause instanceof DocumentFileNotRegularError)
        ) {
          throw cause;
        }
        throw new DocumentFileFinalizeError({
          id: documentId,
          handle,
          cause,
          ...(cleanupCause === undefined ? {} : { cleanupCause }),
          message: `Could not finalize staged document file for ${documentId}: ${describe(cause)}${cleanupCause === undefined ? "" : `; cleanup also failed: ${describe(cleanupCause)}`}`,
        });
      }
    } finally {
      releaseOperation();
    }
  };

  const readDocument = async (id: string) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const documentId = validateDocumentId(id);
      const path = documentPath(documentId);
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await openWithoutFollowingLinks(path, constants.O_RDONLY, path, false);
        ensureTrustedRoots();
        return file.createReadStream({ autoClose: true });
      } catch (cause) {
        await file?.close().catch(() => undefined);
        if (cause instanceof DocumentFileNotRegularError) {
          throw cause;
        }
        throw new DocumentFileReadError({
          id: documentId,
          cause,
          message: `Could not open document file ${documentId}: ${describe(cause)}`,
        });
      }
    } finally {
      releaseOperation();
    }
  };

  const deleteDocumentFile = async (id: string) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const documentId = validateDocumentId(id);
      const path = documentPath(documentId);
      try {
        const stats = await lstat(path);
        if (stats.isSymbolicLink() || !stats.isFile()) {
          throw regularFileError(path);
        }
        await unlinkEntry(documentsDir, `${documentId}.html`);
        await syncDirectory(documentsDir);
        return true;
      } catch (cause) {
        if (isNotFound(cause)) {
          return false;
        }
        if (cause instanceof DocumentFileNotRegularError) {
          throw cause;
        }
        throw new DocumentFileDeleteError({
          id: documentId,
          cause,
          message: `Could not delete document file ${documentId}: ${describe(cause)}`,
        });
      }
    } finally {
      releaseOperation();
    }
  };

  return {
    close,
    stageSourceFile,
    finalizeStagedFile,
    readDocument,
    readDocumentFile: readDocument,
    deleteDocumentFile,
  };
};

const initializeStore = (options: DocumentFileStoreOptions) => {
  const documentsPath = validateDirectoryPath(options.documentsDir, "documentsDir");
  const stagingPathValue = validateDirectoryPath(options.stagingDir, "stagingDir");
  if (samePath(documentsPath, stagingPathValue)) {
    throw new DocumentFileStorePathError({
      path: documentsPath,
      reason: "documentsDir and stagingDir must be different directories.",
      message:
        "Could not initialize document file storage: documentsDir and stagingDir must differ.",
    });
  }

  let documentsDir: TrustedDirectory | undefined;
  let stagingDir: TrustedDirectory | undefined;
  try {
    makePrivateDirectory(documentsPath);
    documentsDir = openTrustedDirectory(documentsPath);
    makePrivateDirectory(stagingPathValue);
    stagingDir = openTrustedDirectory(stagingPathValue);
    if (sameFileIdentity(documentsDir.identity, stagingDir.identity)) {
      throw new DocumentFileStorePathError({
        path: stagingPathValue,
        reason: "documentsDir and stagingDir must not resolve to the same physical directory.",
        message:
          "Could not initialize document file storage: documentsDir and stagingDir must differ physically.",
      });
    }
    return createStore({
      documentsDir,
      stagingDir,
      ...(options.randomBytes === undefined ? {} : { randomBytes: options.randomBytes }),
    });
  } catch (cause) {
    if (documentsDir !== undefined) {
      closeTrustedDirectory(documentsDir);
    }
    if (stagingDir !== undefined) {
      closeTrustedDirectory(stagingDir);
    }
    throw cause;
  }
};

export const openDocumentFileStore = (options: DocumentFileStoreOptions) =>
  Effect.try({
    try: () => initializeStore(options),
    catch: (cause) =>
      isFileStoreError(cause)
        ? cause
        : new DocumentFileStoreOpenError({
            path:
              typeof options?.documentsDir === "string" ? options.documentsDir : String(options),
            cause,
            message: `Could not initialize document file storage: ${describe(cause)}`,
          }),
  });

export { isValidStagedHandle };
