import { randomBytes as cryptoRandomBytes } from "node:crypto";
import type { ReadStream } from "node:fs";
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
  unlinkSync,
  type Stats,
} from "node:fs";
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, normalize, parse, relative, resolve, sep } from "node:path";
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
export const DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS =
  FINALIZATION_LOCK_LEASE_MS + FINALIZATION_LOCK_RECOVERY_GRACE_MS;
const FINALIZATION_LOCK_OWNER_TOKEN_BYTES = 16;
const FINALIZATION_LOCK_RECOVERY_CLAIM_NAME = ".recovery-claim";
const READ_REFERENCE_TOKEN_BYTES = 16;
const READ_REFERENCE_PREFIX = ".read.";
const READ_REFERENCE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const TARGET_LOCK_WAIT_MS = 32;
const TARGET_LOCK_RETRY_DELAY_MS = 1;
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
  /** Clock used for lock leases and startup recovery. */
  readonly now?: () => number;
  /** Private race-test seam; production callers should leave this unset. */
  readonly beforeFinalizationLockRecoveryClaim?: (lockPath: string) => Promise<void>;
  /** Private race-test seam for the hard-link identity check. */
  readonly beforeStagedCloneLink?: (sourcePath: string) => Promise<void>;
  /** Private race-test seam for identity-safe clone compensation. */
  readonly beforeStagedCloneCleanup?: (clonedPath: string) => Promise<void>;
  /** Private race-test seam before the staged source is copied. */
  readonly beforeStagedSourceCopy?: (stagedPath: string) => Promise<void>;
  /** Private race-test seam for identity-safe source cleanup. */
  readonly beforeStagedSourceCleanup?: (stagedPath: string) => Promise<void>;
  /** Private fault seam before target identity inspection. */
  readonly beforeFinalizationTargetInspection?: (targetPath: string) => Promise<void>;
  /** Private fault seam for target residual classification. */
  readonly beforeFinalizationTargetCleanup?: (targetPath: string) => Promise<void>;
  /** Private fault seam immediately before the post-publication staging sync. */
  readonly beforePostPublicationStagingDirectorySync?: () => Promise<void>;
  /** Private race-test seam for target compensation. */
  readonly beforeDocumentTargetDelete?: (targetPath: string) => Promise<void>;
};

declare const stagedDocumentFileHandleBrand: unique symbol;
declare const documentFileTargetCapabilityBrand: unique symbol;

/** A random capability naming one file in the private staging directory. */
export type StagedDocumentFileHandle = string & {
  readonly [stagedDocumentFileHandleBrand]: "StagedDocumentFileHandle";
};

/**
 * The identity returned by finalization and required for coordinator-owned
 * target compensation. It cannot be obtained by inspecting a pathname alone.
 */
export type DocumentFileTargetCapability = Readonly<{
  readonly id: string;
  readonly identity: Readonly<Pick<Stats, "dev" | "ino" | "birthtimeMs">>;
  readonly [documentFileTargetCapabilityBrand]: "DocumentFileTargetCapability";
}>;

export type DocumentFileResourceState = "absent" | "retained" | "unknown";
export type DocumentFileTargetRecoveryPolicy = "delete" | "retain";

export type DocumentFileObservation = Readonly<{
  readonly id: string;
  readonly size: number;
  readonly modifiedAt: number;
}>;

export type DocumentFileReconciliationResult = Readonly<{
  readonly stagedFilesRemoved: number;
  readonly readReferencesRemoved: number;
  readonly finalizationLocksRemoved: number;
  readonly retainedEntries: number;
}>;

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

/** A live peer owns the id-wide target lock; callers may safely retry another id. */
export class DocumentFileTargetBusyError extends Data.TaggedError("DocumentFileTargetBusyError")<{
  readonly id: string;
  readonly message: string;
}> {}

export class DocumentFileFinalizeError extends Data.TaggedError("DocumentFileFinalizeError")<{
  readonly id: string;
  readonly handle: string;
  /** Whether a linked target may still be retained when the failure escaped. */
  readonly targetCreated: boolean;
  /** The identity capability for a target this finalizer linked, if retained or uncertain. */
  readonly targetCapability?: DocumentFileTargetCapability;
  /** Whether coordinator compensation may delete a retained target. */
  readonly targetRecoveryPolicy: DocumentFileTargetRecoveryPolicy;
  /** The best-known path state after any target compensation. */
  readonly targetState: DocumentFileResourceState;
  /** The state of the id-wide target lock used to serialize target cleanup. */
  readonly targetLockState: DocumentFileResourceState;
  /** Whether it is safe for the owning coordinator to try the staged handle. */
  readonly stagingMayBeDiscarded: boolean;
  readonly stagedFileState: DocumentFileResourceState;
  readonly finalizationLockState: DocumentFileResourceState;
  readonly cause: unknown;
  readonly cleanupCause?: unknown;
  readonly message: string;
}> {}

export class DocumentFileDiscardError extends Data.TaggedError("DocumentFileDiscardError")<{
  readonly handle: string;
  readonly stagedFileState: DocumentFileResourceState;
  readonly finalizationLockState: DocumentFileResourceState;
  readonly cause: unknown;
  readonly cleanupCause?: unknown;
  readonly message: string;
}> {}

export class DocumentFileCloneError extends Data.TaggedError("DocumentFileCloneError")<{
  readonly handle: string;
  readonly clonedHandle?: StagedDocumentFileHandle;
  readonly sourceFileState: DocumentFileResourceState;
  readonly clonedFileState: DocumentFileResourceState;
  readonly finalizationLockState: DocumentFileResourceState;
  readonly cause: unknown;
  readonly cleanupCause?: unknown;
  readonly message: string;
}> {}

export class DocumentFileReadError extends Data.TaggedError("DocumentFileReadError")<{
  readonly id: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export class DocumentFileReadActiveError extends Data.TaggedError("DocumentFileReadActiveError")<{
  readonly id: string;
  readonly message: string;
}> {}

export class DocumentFileDeleteError extends Data.TaggedError("DocumentFileDeleteError")<{
  readonly id: string;
  readonly targetState: DocumentFileResourceState;
  readonly targetLockState: DocumentFileResourceState;
  readonly cause: unknown;
  readonly message: string;
}> {}

export interface DocumentFileStore {
  /** Requests closure and resolves after all already-started operations release their leases. */
  readonly close: () => Promise<void>;
  readonly stageSourceFile: (sourcePath: string) => Promise<StagedDocumentFileHandle>;
  readonly finalizeStagedFile: (
    handle: StagedDocumentFileHandle,
    id: string
  ) => Promise<DocumentFileTargetCapability>;
  readonly readDocument: (id: string) => Promise<ReadStream>;
  readonly readDocumentFile: (id: string) => Promise<ReadStream>;
  readonly deleteDocumentFile: (
    id: string,
    expectedTarget?: DocumentFileTargetCapability
  ) => Promise<boolean>;
  /** Runs the retention decision while the id-wide target lock is held. */
  readonly deleteDocumentFileIf: (
    id: string,
    shouldDelete: (targetExists: boolean) => boolean | Promise<boolean>
  ) => Promise<boolean>;
  readonly listDocumentFiles: () => Promise<readonly DocumentFileObservation[]>;
  /** Reclaims only stale, provably-owned staging and lock entries. */
  readonly reconcileDocumentFiles: () => Promise<DocumentFileReconciliationResult>;
  /** Creates a second immutable staged handle without reopening source input. */
  readonly cloneStagedFile: (handle: StagedDocumentFileHandle) => Promise<StagedDocumentFileHandle>;
  /** Safely consumes a staged handle when a coordinator needs compensation. */
  readonly discardStagedFile: (handle: StagedDocumentFileHandle) => Promise<boolean>;
}

const isFileStoreError = (error: unknown) =>
  error instanceof DocumentFileStorePathError ||
  error instanceof DocumentFileStoreOpenError ||
  error instanceof DocumentFileStoreClosedError ||
  error instanceof DocumentFileSourceError ||
  error instanceof DocumentFileNotRegularError ||
  error instanceof InvalidStagedDocumentFileHandleError ||
  error instanceof DocumentFileAlreadyExistsError ||
  error instanceof DocumentFileTargetBusyError ||
  error instanceof DocumentFileFinalizeError ||
  error instanceof DocumentFileDiscardError ||
  error instanceof DocumentFileCloneError ||
  error instanceof DocumentFileReadError ||
  error instanceof DocumentFileReadActiveError ||
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
  if (left.dev !== right.dev || left.ino !== right.ino) {
    return false;
  }

  // Device/inode is the usual POSIX identity, but birthtime distinguishes an
  // inode that has been recycled while both observations retain the same
  // device/inode pair. Node exposes birthtimeMs on the supported platforms;
  // if an adapter supplies a non-finite value, fall back to dev/ino rather
  // than rejecting a platform that does not report creation time.
  const leftBirthtime = Number.isFinite(left.birthtimeMs) ? left.birthtimeMs : undefined;
  const rightBirthtime = Number.isFinite(right.birthtimeMs) ? right.birthtimeMs : undefined;
  if (leftBirthtime !== undefined && rightBirthtime !== undefined) {
    return leftBirthtime === rightBirthtime;
  }

  // When birthtime is unavailable, dev/ino is still useful if the filesystem
  // reports either component. With all three fields unavailable there is no
  // identity proof, so cleanup must fail closed.
  return left.dev !== 0 || left.ino !== 0 || right.dev !== 0 || right.ino !== 0;
};

const targetCapabilityFor = (id: string, identity: FileIdentity) =>
  Object.freeze({
    id,
    identity: Object.freeze({
      dev: identity.dev,
      ino: identity.ino,
      birthtimeMs: identity.birthtimeMs,
    }),
  }) as DocumentFileTargetCapability;

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
    const metadataIdentity = await metadataFile.stat();
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
      metadata: {
        version: 1,
        owner: { pid, host, token },
        acquiredAt,
        leaseExpiresAt,
      } satisfies FinalizationLockMetadata,
      identity: lockStats,
      metadataIdentity,
    };
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

type FinalizationRecoveryClaim = {
  readonly version: 1;
  readonly owner: {
    readonly pid: number;
    readonly host: string;
  };
  readonly token: string;
  readonly claimedAt: number;
  readonly leaseExpiresAt: number;
};

type FinalizationRecoveryClaimObservation = FinalizationRecoveryClaim & {
  readonly identity: FileIdentity;
};

type FinalizationLockLease = {
  readonly identity: FileIdentity;
  readonly metadataIdentity?: FileIdentity;
  readonly recoveryClaimName?: string;
  readonly recoveryClaimIdentity?: FileIdentity;
};

type ReadReferenceLease = Readonly<{
  readonly path: string;
  readonly identity: FileIdentity;
}>;

type ReadReferenceMetadata = Readonly<{
  readonly version: 1;
  readonly owner: Readonly<{
    readonly pid: number;
    readonly host: string;
  }>;
  readonly acquiredAt: number;
}>;

const readFinalizationRecoveryClaim = async (claimPath: string) => {
  let claimFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    claimFile = await openWithoutFollowingLinks(claimPath, constants.O_RDONLY, claimPath, false);
    const claimIdentity = await claimFile.stat();
    const contents = Buffer.alloc(FINALIZATION_LOCK_METADATA_BYTES + 1);
    const { bytesRead } = await claimFile.read(contents, 0, contents.length, 0);
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
    const ownerValue = Reflect.get(parsed, "owner");
    if (!isRecord(ownerValue)) {
      return undefined;
    }
    const owner = ownerValue;
    const { version, token, claimedAt, leaseExpiresAt } = parsed;
    const { pid, host } = owner;
    if (
      version !== 1 ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof host !== "string" ||
      host.length === 0 ||
      typeof token !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(token) ||
      typeof claimedAt !== "number" ||
      !Number.isSafeInteger(claimedAt) ||
      typeof leaseExpiresAt !== "number" ||
      !Number.isSafeInteger(leaseExpiresAt) ||
      claimedAt < 0 ||
      leaseExpiresAt < claimedAt ||
      leaseExpiresAt - claimedAt > FINALIZATION_LOCK_LEASE_MS
    ) {
      return undefined;
    }
    return {
      version: 1,
      owner: { pid, host },
      token,
      claimedAt,
      leaseExpiresAt,
      identity: claimIdentity,
    } satisfies FinalizationRecoveryClaimObservation;
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  } finally {
    await claimFile?.close();
  }
};

const removeFinalizationLockDirectory = async (lockPath: string, lease?: FinalizationLockLease) => {
  if (lease !== undefined) {
    const current = await lstat(lockPath);
    if (!sameFileIdentity(lease.identity, current)) {
      throw new Error("The finalization lock was replaced before its owner could release it.");
    }
  }

  const metadataPath = join(lockPath, FINALIZATION_LOCK_METADATA_NAME);
  if (lease !== undefined) {
    try {
      const currentMetadata = await lstat(metadataPath);
      if (
        lease.metadataIdentity === undefined ||
        !sameFileIdentity(lease.metadataIdentity, currentMetadata)
      ) {
        throw new Error(
          "The finalization lock metadata identity was unavailable or replaced before release."
        );
      }
    } catch (cause) {
      if (!isNotFound(cause)) {
        throw cause;
      }
    }
  }
  try {
    await unlink(metadataPath);
  } catch (cause) {
    if (!isNotFound(cause)) {
      throw cause;
    }
  }
  if (lease?.recoveryClaimName !== undefined) {
    const recoveryClaimPath = join(lockPath, lease.recoveryClaimName);
    try {
      const currentClaim = await lstat(recoveryClaimPath);
      if (
        lease.recoveryClaimIdentity === undefined ||
        !sameFileIdentity(lease.recoveryClaimIdentity, currentClaim)
      ) {
        throw new Error("The stale-lock recovery claim identity was unavailable or replaced.");
      }
    } catch (cause) {
      if (!isNotFound(cause)) {
        throw cause;
      }
    }
    try {
      await unlink(recoveryClaimPath);
    } catch (cause) {
      if (!isNotFound(cause)) {
        throw cause;
      }
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

const recoverStaleFinalizationLock = async (
  lockPath: string,
  now: () => number,
  beforeClaim?: (lockPath: string) => Promise<void>
) => {
  const observation = await readFinalizationLockMetadata(lockPath);
  const metadata = observation?.metadata;
  if (
    observation === undefined ||
    metadata === undefined ||
    metadata.owner.host !== LOCAL_HOSTNAME ||
    metadata.leaseExpiresAt > now() - FINALIZATION_LOCK_RECOVERY_GRACE_MS ||
    isProcessAlive(metadata.owner.pid)
  ) {
    return undefined;
  }

  const claimPath = join(lockPath, FINALIZATION_LOCK_RECOVERY_CLAIM_NAME);
  // A fixed claim name is deliberate: O_EXCL is the one atomic transition that
  // gives a stale-lock recovery owner authority. Random claim names let two
  // recoverers both believe they won. An existing claim is only reapable when
  // its claimant is definitely dead; otherwise the lock remains busy.
  try {
    const existingClaim = await readFinalizationRecoveryClaim(claimPath);
    if (existingClaim !== undefined) {
      if (
        existingClaim.owner.host !== LOCAL_HOSTNAME ||
        existingClaim.leaseExpiresAt > now() - FINALIZATION_LOCK_RECOVERY_GRACE_MS ||
        isProcessAlive(existingClaim.owner.pid)
      ) {
        return undefined;
      }
      // Do not guess when an old claim has malformed or replaced contents. A
      // well-formed, definitely dead claim can be removed before the exclusive
      // create below; competing removers are harmless because only one create
      // can succeed. If the directory changed, leave it untouched and report busy.
      const current = await lstat(lockPath);
      if (!sameFileIdentity(observation.identity, current)) {
        return undefined;
      }
      try {
        const currentClaim = await lstat(claimPath);
        if (!sameFileIdentity(existingClaim.identity, currentClaim)) {
          return undefined;
        }
        await unlink(claimPath);
      } catch (cause) {
        if (!isNotFound(cause)) {
          throw cause;
        }
      }
    } else {
      try {
        await lstat(claimPath);
        // A malformed claim is intentionally retained. It is not safe to infer
        // that its owner is gone from untrusted bytes.
        return undefined;
      } catch (cause) {
        if (!isNotFound(cause)) {
          throw cause;
        }
      }
    }
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }

  await beforeClaim?.(lockPath);
  let claimFile: Awaited<ReturnType<typeof open>> | undefined;
  let claimIdentity: FileIdentity | undefined;
  try {
    claimFile = await open(
      claimPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      PRIVATE_FILE_MODE
    );
    const claimedAt = now();
    await claimFile.writeFile(
      JSON.stringify({
        version: 1,
        owner: { pid: process.pid, host: LOCAL_HOSTNAME },
        token: metadata.owner.token,
        claimedAt,
        leaseExpiresAt: claimedAt + FINALIZATION_LOCK_LEASE_MS,
      }),
      "utf8"
    );
    await claimFile.sync();
    claimIdentity = await claimFile.stat();
  } catch (cause) {
    if (errorCode(cause) === "EEXIST" || isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  } finally {
    await claimFile?.close().catch(() => undefined);
  }

  const discardClaim = async () => {
    if (claimIdentity === undefined) {
      return;
    }
    try {
      const currentClaim = await lstat(claimPath);
      if (sameFileIdentity(claimIdentity, currentClaim)) {
        await unlink(claimPath);
      }
    } catch (cause) {
      if (!isNotFound(cause)) {
        throw cause;
      }
    }
  };

  try {
    const current = await lstat(lockPath);
    if (!sameFileIdentity(observation.identity, current)) {
      // Remove only the marker inode created by this attempt. If the path was
      // replaced after the marker was created, the marker is in the old
      // directory; if it was replaced before creation, this removes our marker
      // from the replacement without touching its owner metadata.
      await discardClaim();
      return undefined;
    }

    // The first stale observation is only a candidate. A cooperating owner may
    // have refreshed/replaced its metadata while the recovery claim was being
    // acquired. Re-read both identities and the lease immediately before
    // handing the lock to the remover; never let an old directory listing
    // authorize deletion of a fresh lock.
    const freshObservation = await readFinalizationLockMetadata(lockPath);
    const freshMetadata = freshObservation?.metadata;
    const metadataStillMatches =
      freshMetadata !== undefined &&
      freshObservation !== undefined &&
      sameFileIdentity(observation.identity, freshObservation.identity) &&
      observation.metadataIdentity !== undefined &&
      sameFileIdentity(observation.metadataIdentity, freshObservation.metadataIdentity) &&
      freshMetadata.owner.pid === metadata.owner.pid &&
      freshMetadata.owner.host === metadata.owner.host &&
      freshMetadata.owner.token === metadata.owner.token &&
      freshMetadata.acquiredAt === metadata.acquiredAt &&
      freshMetadata.leaseExpiresAt === metadata.leaseExpiresAt;
    if (
      !metadataStillMatches ||
      freshMetadata.owner.host !== LOCAL_HOSTNAME ||
      freshMetadata.leaseExpiresAt > now() - FINALIZATION_LOCK_RECOVERY_GRACE_MS ||
      isProcessAlive(freshMetadata.owner.pid)
    ) {
      await discardClaim();
      return undefined;
    }

    const currentClaim = await lstat(claimPath);
    return {
      identity: current,
      metadataIdentity: freshObservation.metadataIdentity,
      recoveryClaimName: FINALIZATION_LOCK_RECOVERY_CLAIM_NAME,
      recoveryClaimIdentity: currentClaim,
    } satisfies FinalizationLockLease;
  } catch (cause) {
    if (isNotFound(cause)) {
      await discardClaim().catch(() => undefined);
      return undefined;
    }
    await discardClaim().catch(() => undefined);
    throw cause;
  }
};

const createFinalizationLockMetadata = (now: () => number) => {
  const acquiredAt = now();
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

const acquireFinalizationLock = async (
  lockPath: string,
  now: () => number,
  beforeRecoveryClaim?: (lockPath: string) => Promise<void>
) => {
  let createdIdentity: FileIdentity | undefined;
  try {
    await mkdir(lockPath, { mode: PRIVATE_DIRECTORY_MODE });
    createdIdentity = await lstat(lockPath);
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") {
      throw cause;
    }
    try {
      const recovered = await recoverStaleFinalizationLock(lockPath, now, beforeRecoveryClaim);
      if (recovered !== undefined) {
        return recovered;
      }
    } catch {
      // A lock that cannot be inspected or atomically claimed is retained.
      // Treat it as busy rather than deleting the staged file behind an owner.
    }
    throw new FinalizationLockBusyError("The staged document file is already being finalized.");
  }

  const metadataPath = join(lockPath, FINALIZATION_LOCK_METADATA_NAME);
  const metadata = createFinalizationLockMetadata(now);
  let metadataFile: Awaited<ReturnType<typeof open>> | undefined;
  let metadataIdentity: FileIdentity | undefined;
  try {
    metadataFile = await open(
      metadataPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      PRIVATE_FILE_MODE
    );
    await metadataFile.writeFile(JSON.stringify(metadata), "utf8");
    await metadataFile.sync();
    metadataIdentity = await metadataFile.stat();
    await metadataFile.close();
    metadataFile = undefined;
  } catch (cause) {
    await metadataFile?.close().catch(() => undefined);
    metadataFile = undefined;
    try {
      await removeFinalizationLockDirectory(
        lockPath,
        createdIdentity === undefined ? undefined : { identity: createdIdentity }
      );
    } catch (cleanupCause) {
      throw new Error(
        `Could not initialize finalization lock: ${describe(cause)}; cleanup also failed: ${describe(cleanupCause)}`
      );
    }
    throw cause;
  }
  const identity = await lstat(lockPath);
  return {
    identity,
    ...(metadataIdentity === undefined ? {} : { metadataIdentity }),
  } satisfies FinalizationLockLease;
};

const readReferenceName = (id: string, token: string) => `${READ_REFERENCE_PREFIX}${id}.${token}`;

const readReferenceEntry = (entry: string) => {
  if (!entry.startsWith(READ_REFERENCE_PREFIX)) {
    return undefined;
  }
  const remainder = entry.slice(READ_REFERENCE_PREFIX.length);
  const separator = remainder.lastIndexOf(".");
  if (separator <= 0) {
    return undefined;
  }
  const id = remainder.slice(0, separator);
  const token = remainder.slice(separator + 1);
  return /^[A-Za-z0-9_-]{21}$/.test(id) && READ_REFERENCE_TOKEN_PATTERN.test(token)
    ? { id, token }
    : undefined;
};

const readReferenceParts = (entry: string, id: string) => {
  const reference = readReferenceEntry(entry);
  return reference?.id === id ? reference.token : undefined;
};

const parseReadReferenceMetadata = (value: unknown): ReadReferenceMetadata | undefined => {
  if (!isRecord(value)) {
    return undefined;
  }
  const { version, owner: ownerValue, acquiredAt } = value;
  if (!isRecord(ownerValue)) {
    return undefined;
  }
  const { pid, host } = ownerValue;
  if (
    version !== 1 ||
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof host !== "string" ||
    host.length === 0 ||
    typeof acquiredAt !== "number" ||
    !Number.isSafeInteger(acquiredAt) ||
    acquiredAt < 0
  ) {
    return undefined;
  }
  return {
    version: 1,
    owner: { pid, host },
    acquiredAt,
  };
};

const readReadReference = async (path: string) => {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = await openWithoutFollowingLinks(path, constants.O_RDONLY, path, false);
    const identity = await file.stat();
    const contents = Buffer.alloc(FINALIZATION_LOCK_METADATA_BYTES + 1);
    const { bytesRead } = await file.read(contents, 0, contents.length, 0);
    if (bytesRead > FINALIZATION_LOCK_METADATA_BYTES) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents.subarray(0, bytesRead).toString("utf8"));
    } catch {
      return undefined;
    }
    const metadata = parseReadReferenceMetadata(parsed);
    return metadata === undefined ? undefined : { metadata, identity };
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  } finally {
    await file?.close();
  }
};

const createReadReference = async (
  stagingDir: TrustedDirectory,
  id: string,
  now: () => number
): Promise<ReadReferenceLease> => {
  for (let attempt = 0; attempt < MAX_STAGED_ALLOCATION_ATTEMPTS; attempt += 1) {
    const token = cryptoRandomBytes(READ_REFERENCE_TOKEN_BYTES).toString("base64url");
    const name = readReferenceName(id, token);
    const path = entryPath(stagingDir, name);
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        PRIVATE_FILE_MODE
      );
      await file.writeFile(
        JSON.stringify({
          version: 1,
          owner: { pid: process.pid, host: LOCAL_HOSTNAME },
          acquiredAt: now(),
        }),
        "utf8"
      );
      await file.sync();
      const identity = await file.stat();
      // Keep the release path independent of the optional /proc fd. Store
      // shutdown may close that directory fd before a forced stream close;
      // the same identity check still prevents unlinking a replacement.
      return { path: join(stagingDir.path, name), identity };
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") {
        throw cause;
      }
    } finally {
      await file?.close().catch(() => undefined);
    }
  }
  throw new Error("Could not allocate a unique active-read reference.");
};

const releaseReadReference = (reference: ReadReferenceLease) => {
  try {
    const current = lstatSync(reference.path);
    if (sameFileIdentity(reference.identity, current)) {
      unlinkSync(reference.path);
    }
  } catch {
    // A missing reference is already released. Any replacement is retained.
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
  now = Date.now,
  beforeFinalizationLockRecoveryClaim,
  beforeStagedCloneLink,
  beforeStagedCloneCleanup,
  beforeStagedSourceCopy,
  beforeStagedSourceCleanup,
  beforeFinalizationTargetInspection,
  beforeFinalizationTargetCleanup,
  beforePostPublicationStagingDirectorySync,
  beforeDocumentTargetDelete,
}: {
  readonly documentsDir: TrustedDirectory;
  readonly stagingDir: TrustedDirectory;
  readonly randomBytes?: (size: number) => Uint8Array;
  readonly now?: () => number;
  readonly beforeFinalizationLockRecoveryClaim?: (lockPath: string) => Promise<void>;
  readonly beforeStagedCloneLink?: (sourcePath: string) => Promise<void>;
  readonly beforeStagedCloneCleanup?: (clonedPath: string) => Promise<void>;
  readonly beforeStagedSourceCopy?: (stagedPath: string) => Promise<void>;
  readonly beforeStagedSourceCleanup?: (stagedPath: string) => Promise<void>;
  readonly beforeFinalizationTargetInspection?: (targetPath: string) => Promise<void>;
  readonly beforeFinalizationTargetCleanup?: (targetPath: string) => Promise<void>;
  readonly beforePostPublicationStagingDirectorySync?: () => Promise<void>;
  readonly beforeDocumentTargetDelete?: (targetPath: string) => Promise<void>;
}) => {
  const stagedIdentities = new Map<string, FileIdentity>();
  const documentMutexes = new Map<string, Promise<void>>();
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

  const withDocumentMutex = async <Value>(id: string, operation: () => Promise<Value>) => {
    const previous = documentMutexes.get(id);
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    documentMutexes.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (documentMutexes.get(id) === current) {
        documentMutexes.delete(id);
      }
    }
  };

  const activeReadReferenceExists = async (id: string) => {
    const entries = await readdir(entryPath(stagingDir, ""));
    let removedStaleReference = false;
    for (const entry of entries) {
      if (readReferenceParts(entry, id) === undefined) {
        continue;
      }
      const path = entryPath(stagingDir, entry);
      let current: Stats;
      try {
        current = await lstat(path);
      } catch (cause) {
        if (isNotFound(cause)) {
          continue;
        }
        throw cause;
      }
      const observation = await readReadReference(path);
      if (
        observation === undefined ||
        observation.metadata.owner.host !== LOCAL_HOSTNAME ||
        isProcessAlive(observation.metadata.owner.pid)
      ) {
        // A malformed marker, a reference owned by another host, and a live
        // same-host owner all fail closed. Only a well-formed reference whose
        // local owner is definitely dead may be reclaimed.
        return true;
      }
      if (!sameFileIdentity(current, observation.identity)) {
        return true;
      }
      try {
        const fresh = await lstat(path);
        if (!sameFileIdentity(observation.identity, fresh)) {
          return true;
        }
        await unlink(path);
        removedStaleReference = true;
      } catch (cause) {
        if (!isNotFound(cause)) {
          return true;
        }
      }
    }
    if (removedStaleReference) {
      await syncDirectory(stagingDir);
    }
    return false;
  };

  const stagingPath = (handle: unknown) => entryPath(stagingDir, validateStagedHandle(handle));
  const documentPath = (id: string) => entryPath(documentsDir, `${validateDocumentId(id)}.html`);
  const targetLockPath = (id: string) => entryPath(stagingDir, `.${id}.target.lock`);
  const acquireTargetLock = async (id: string) => {
    const path = targetLockPath(id);
    const deadline = process.hrtime.bigint() + BigInt(TARGET_LOCK_WAIT_MS) * 1_000_000n;
    while (true) {
      try {
        return await acquireFinalizationLock(path, now, beforeFinalizationLockRecoveryClaim);
      } catch (cause) {
        if (!(cause instanceof FinalizationLockBusyError)) {
          throw cause;
        }
        const remaining = deadline - process.hrtime.bigint();
        if (remaining <= 0n) {
          throw new DocumentFileTargetBusyError({
            id,
            message: `Document target ${id} remained locked by a live peer after ${TARGET_LOCK_WAIT_MS}ms.`,
          });
        }
        const milliseconds = Number((remaining + 999_999n) / 1_000_000n);
        await new Promise<void>((resolvePromise) =>
          setTimeout(resolvePromise, Math.min(TARGET_LOCK_RETRY_DELAY_MS, milliseconds))
        );
      }
    }
  };
  const releaseTargetLock = async (id: string, lease: FinalizationLockLease) => {
    await removeFinalizationLockDirectory(targetLockPath(id), lease);
    await syncDirectory(stagingDir);
  };
  const discardEntry = async (
    directory: TrustedDirectory,
    name: string,
    expectedIdentity: FileIdentity
  ) => {
    verifyTrustedDirectory(directory);
    const path = entryPath(directory, name);
    let current: Stats;
    try {
      current = await lstat(path);
    } catch (cause) {
      if (isNotFound(cause)) {
        return false;
      }
      throw cause;
    }
    if (current.isSymbolicLink() || !current.isFile()) {
      throw regularFileError(path);
    }
    if (!sameFileIdentity(expectedIdentity, current)) {
      throw new Error("The file was replaced before identity-safe discard.");
    }
    await unlink(path);
    return true;
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
            // Retain the inode identity for every later cleanup. A handle is a
            // pathname capability, not proof that a replacement at that path
            // belongs to this staging operation.
            stagedIdentities.set(candidate, stagedStats);
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
        await beforeStagedSourceCopy?.(stagingPath(handle));

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
          stagedIdentities.set(handle, await durableStaged.stat());
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
            await beforeStagedSourceCleanup?.(stagingPath(handle));
            await discardStagedFile(handle);
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
      const targetLockPath = entryPath(stagingDir, `.${documentId}.target.lock`);
      let source: Awaited<ReturnType<typeof open>> | undefined;
      let lockLease: FinalizationLockLease | undefined;
      let lockOwned = false;
      let anotherFinalizerOwnsLock = false;
      let targetLockLease: FinalizationLockLease | undefined;
      let targetLockOwned = false;
      let stagedFileState: DocumentFileResourceState = "retained";
      let finalizationLockState: DocumentFileResourceState = "absent";
      let targetLockState: DocumentFileResourceState = "absent";
      let targetNeedsCleanup = false;
      let targetCreated = false;
      let postPublicationStagingSyncFailed = false;
      let targetRecoveryPolicy: DocumentFileTargetRecoveryPolicy = "delete";
      let targetState: DocumentFileResourceState = "absent";
      let targetIdentity: FileIdentity | undefined;
      let targetCapability: DocumentFileTargetCapability | undefined;
      let sourceIdentity: FileIdentity | undefined;
      let cleanupCause: unknown;
      const discardFinalizationStaged = async () => {
        const expectedIdentity = sourceIdentity ?? stagedIdentities.get(handle);
        if (expectedIdentity === undefined) {
          try {
            await lstat(sourcePath);
          } catch (cause) {
            if (isNotFound(cause)) {
              stagedIdentities.delete(handle);
              return false;
            }
            throw cause;
          }
          throw new Error("The staged document file identity was unavailable for cleanup.");
        }
        await beforeStagedSourceCleanup?.(sourcePath);
        const removed = await discardEntry(stagingDir, handle, expectedIdentity);
        stagedIdentities.delete(handle);
        return removed;
      };

      try {
        const expectedStagedIdentity = stagedIdentities.get(handle);
        try {
          source = await openWithoutFollowingLinks(
            sourcePath,
            constants.O_RDONLY,
            sourcePath,
            false
          );
        } catch (sourceOpenCause) {
          stagedFileState = isNotFound(sourceOpenCause) ? "absent" : "unknown";
          throw sourceOpenCause;
        }
        const sourceStats = await source.stat();
        sourceIdentity = sourceStats;
        validateSourceFileSize(sourceStats.size);
        if (
          expectedStagedIdentity !== undefined &&
          !sameFileIdentity(expectedStagedIdentity, sourceStats)
        ) {
          stagedFileState = "unknown";
          throw new Error("The staged document file was replaced before finalization.");
        }

        try {
          lockLease = await acquireFinalizationLock(
            lockPath,
            now,
            beforeFinalizationLockRecoveryClaim
          );
          lockOwned = true;
          finalizationLockState = "retained";
          await syncDirectory(stagingDir);
        } catch (cause) {
          if (cause instanceof FinalizationLockBusyError) {
            anotherFinalizerOwnsLock = true;
            finalizationLockState = "retained";
          } else {
            finalizationLockState = "unknown";
          }
          throw cause;
        }

        try {
          const waitDeadline = process.hrtime.bigint() + BigInt(TARGET_LOCK_WAIT_MS) * 1_000_000n;
          let targetLockCause: unknown;
          while (targetLockLease === undefined) {
            try {
              targetLockLease = await acquireFinalizationLock(
                targetLockPath,
                now,
                beforeFinalizationLockRecoveryClaim
              );
              targetLockCause = undefined;
            } catch (cause) {
              targetLockCause = cause;
              if (!(cause instanceof FinalizationLockBusyError)) {
                break;
              }
              const remainingNanoseconds = waitDeadline - process.hrtime.bigint();
              if (remainingNanoseconds <= 0n) {
                break;
              }
              const remainingMilliseconds = Number((remainingNanoseconds + 999_999n) / 1_000_000n);
              await new Promise<void>((resolve) =>
                setTimeout(resolve, Math.min(TARGET_LOCK_RETRY_DELAY_MS, remainingMilliseconds))
              );
            }
          }
          if (targetLockLease === undefined) {
            if (targetLockCause instanceof FinalizationLockBusyError) {
              throw new DocumentFileTargetBusyError({
                id: documentId,
                message: `Document target ${documentId} remained locked by a live peer after ${TARGET_LOCK_WAIT_MS}ms.`,
              });
            }
            throw targetLockCause ?? new FinalizationLockBusyError("The target is busy.");
          }
          targetLockOwned = true;
          targetLockState = "retained";
          await syncDirectory(stagingDir);
        } catch (cause) {
          // A busy peer owns this id-wide lock. It is not this finalizer's
          // resource and must not be surfaced as this caller's retained lock.
          targetLockState = cause instanceof DocumentFileTargetBusyError ? "absent" : "unknown";
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
          targetCreated = true;
          targetState = "retained";
        } catch (cause) {
          if (errorCode(cause) === "EEXIST") {
            await classifyTargetCollision(targetPath, documentId);
          }
          throw cause;
        }

        await beforeFinalizationTargetInspection?.(targetPath);
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
        targetCapability = targetCapabilityFor(documentId, targetStats);

        await beforeFinalizationTargetCleanup?.(targetPath);
        await syncDirectory(documentsDir);
        // Once the target directory is synced, the target is the recoverable
        // durable result. Later staging cleanup failures must not retract it.
        targetRecoveryPolicy = "retain";
        targetNeedsCleanup = false;
        await source.close();
        source = undefined;
        await discardFinalizationStaged();
        stagedFileState = "absent";
        await removeFinalizationLockDirectory(lockPath, lockLease);
        lockLease = undefined;
        lockOwned = false;
        finalizationLockState = "absent";
        await removeFinalizationLockDirectory(targetLockPath, targetLockLease);
        targetLockLease = undefined;
        targetLockOwned = false;
        targetLockState = "absent";
        try {
          await beforePostPublicationStagingDirectorySync?.();
          await syncDirectory(stagingDir);
        } catch (postPublicationSyncCause) {
          // A failed directory sync makes the durability of every just-removed
          // staging entry ambiguous. Keep all residual states recoverable and
          // let the coordinator preserve the already-synced target.
          postPublicationStagingSyncFailed = true;
          stagedFileState = "unknown";
          finalizationLockState = "unknown";
          targetLockState = "unknown";
          throw postPublicationSyncCause;
        }
        if (targetCapability === undefined) {
          throw new Error("The finalized document target identity was unavailable.");
        }
        return targetCapability;
      } catch (cause) {
        await source?.close().catch((closeError) => {
          cleanupCause ??= closeError;
        });
        source = undefined;

        if (targetNeedsCleanup && targetLockOwned) {
          try {
            if (targetIdentity === undefined) {
              // A successful link is not enough to authorize pathname cleanup:
              // if target inspection failed, we cannot prove that this path is
              // still the inode created by this finalizer. Inspect only to
              // distinguish a known-absent path; never delete without the
              // identity captured immediately after link().
              try {
                await lstat(targetPath);
              } catch (inspectionCause) {
                if (isNotFound(inspectionCause)) {
                  targetNeedsCleanup = false;
                  targetCreated = false;
                  targetState = "absent";
                } else {
                  throw inspectionCause;
                }
              }
              if (targetNeedsCleanup) {
                throw new Error(
                  "The finalized document target identity was unavailable for cleanup."
                );
              }
            } else {
              const removedTarget = await discardEntry(
                documentsDir,
                `${documentId}.html`,
                targetIdentity
              );
              targetNeedsCleanup = false;
              targetCreated = false;
              targetState = "absent";
              if (removedTarget) {
                try {
                  await syncDirectory(documentsDir);
                } catch (targetSyncCleanupError) {
                  targetState = "unknown";
                  cleanupCause ??= targetSyncCleanupError;
                }
              }
            }
          } catch (targetCleanupError) {
            if (isNotFound(targetCleanupError)) {
              targetNeedsCleanup = false;
              targetCreated = false;
              targetState = "absent";
            } else {
              // The path may now be a replacement. Publication compensation
              // must not delete it by document id after identity is uncertain.
              targetState = "unknown";
              cleanupCause ??= targetCleanupError;
            }
          }
        }

        if (lockOwned) {
          try {
            await discardFinalizationStaged();
            stagedFileState = "absent";
          } catch (sourceCleanupError) {
            if (isNotFound(sourceCleanupError)) {
              stagedFileState = "absent";
            } else {
              stagedFileState = "unknown";
              cleanupCause ??= sourceCleanupError;
            }
          }
          try {
            await removeFinalizationLockDirectory(lockPath, lockLease);
            lockLease = undefined;
            lockOwned = false;
            finalizationLockState = "absent";
          } catch (lockCleanupError) {
            if (!isNotFound(lockCleanupError)) {
              finalizationLockState = "retained";
              cleanupCause ??= lockCleanupError;
            } else {
              lockLease = undefined;
              lockOwned = false;
              finalizationLockState = "absent";
            }
          }
        } else if (!anotherFinalizerOwnsLock && !postPublicationStagingSyncFailed) {
          // Cleanup takes the same per-handle lock even when this finalizer
          // failed before acquiring it. A busy lock is retained for its owner.
          try {
            await discardFinalizationStaged();
            stagedFileState = "absent";
          } catch (sourceCleanupError) {
            if (isNotFound(sourceCleanupError)) {
              stagedFileState = "absent";
            } else {
              stagedFileState = "unknown";
              cleanupCause ??= sourceCleanupError;
            }
          }
        }

        if (targetLockOwned) {
          try {
            await removeFinalizationLockDirectory(targetLockPath, targetLockLease);
            targetLockLease = undefined;
            targetLockOwned = false;
            targetLockState = "absent";
          } catch (targetLockCleanupError) {
            if (isNotFound(targetLockCleanupError)) {
              targetLockLease = undefined;
              targetLockOwned = false;
              targetLockState = "absent";
            } else {
              targetLockState = "retained";
              cleanupCause ??= targetLockCleanupError;
            }
          }
        }

        if (
          cleanupCause === undefined &&
          (cause instanceof DocumentFileAlreadyExistsError ||
            cause instanceof DocumentFileTargetBusyError ||
            cause instanceof DocumentFileNotRegularError)
        ) {
          throw cause;
        }
        throw new DocumentFileFinalizeError({
          id: documentId,
          handle,
          targetCreated,
          ...(targetCapability === undefined ? {} : { targetCapability }),
          targetRecoveryPolicy,
          targetState,
          targetLockState,
          stagingMayBeDiscarded: !anotherFinalizerOwnsLock && finalizationLockState === "absent",
          stagedFileState,
          finalizationLockState,
          cause,
          ...(cleanupCause === undefined ? {} : { cleanupCause }),
          message: `Could not finalize staged document file for ${documentId}: ${describe(cause)}${cleanupCause === undefined ? "" : `; cleanup also failed: ${describe(cleanupCause)}`}`,
        });
      }
    } finally {
      releaseOperation();
    }
  };

  const cloneStagedFile = async (handleValue: StagedDocumentFileHandle) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const handle = validateStagedHandle(handleValue);
      const sourcePath = stagingPath(handle);
      const lockPath = entryPath(stagingDir, `.${handle}.lock`);
      let source: Awaited<ReturnType<typeof open>> | undefined;
      let targetHandle: StagedDocumentFileHandle | undefined;
      let targetIdentity: FileIdentity | undefined;
      let lockLease: FinalizationLockLease | undefined;
      let lockOwned = false;
      let sourceFileState: DocumentFileResourceState = "retained";
      let clonedFileState: DocumentFileResourceState = "absent";
      let finalizationLockState: DocumentFileResourceState = "absent";
      let targetCreated = false;
      let cleanupCause: unknown;

      const linkClone = async (candidate: StagedDocumentFileHandle) => {
        // Check the pathname again after the race seam and immediately before
        // link(). The descriptor check below remains authoritative if the path
        // is replaced in the small interval that follows.
        const sourceFile = source;
        let sourceBeforeLink: Stats;
        try {
          sourceBeforeLink = await lstat(sourcePath);
        } catch (cause) {
          sourceFileState = isNotFound(cause) ? "absent" : "unknown";
          throw cause;
        }
        let sourceAtLink: Stats | undefined;
        try {
          sourceAtLink = await sourceFile?.stat();
        } catch (cause) {
          sourceFileState = "unknown";
          throw cause;
        }
        if (
          sourceFile === undefined ||
          sourceAtLink === undefined ||
          sourceBeforeLink.isSymbolicLink() ||
          !sourceBeforeLink.isFile() ||
          !sameFileIdentity(sourceBeforeLink, sourceAtLink)
        ) {
          sourceFileState = "unknown";
          throw new Error("The staged source file changed before it was cloned.");
        }
        await link(sourcePath, stagingPath(candidate));
        targetHandle = candidate;
        targetCreated = true;
        clonedFileState = "retained";
        const clonedStats = await lstat(stagingPath(candidate));
        targetIdentity = clonedStats;
        stagedIdentities.set(candidate, clonedStats);
        let sourceAfterLink: Stats;
        try {
          sourceAfterLink = await sourceFile.stat();
        } catch (cause) {
          sourceFileState = "unknown";
          throw cause;
        }
        if (
          clonedStats.isSymbolicLink() ||
          !clonedStats.isFile() ||
          !sameFileIdentity(clonedStats, sourceAfterLink) ||
          clonedStats.size !== sourceAfterLink.size
        ) {
          sourceFileState = "unknown";
          throw new Error("The cloned staged document file changed while it was being linked.");
        }
      };

      try {
        try {
          lockLease = await acquireFinalizationLock(
            lockPath,
            now,
            beforeFinalizationLockRecoveryClaim
          );
          lockOwned = true;
          finalizationLockState = "retained";
          await syncDirectory(stagingDir);
        } catch (cause) {
          if (cause instanceof FinalizationLockBusyError) {
            finalizationLockState = "retained";
          } else {
            finalizationLockState = "unknown";
          }
          throw cause;
        }

        try {
          source = await openWithoutFollowingLinks(
            sourcePath,
            constants.O_RDONLY,
            sourcePath,
            false
          );
        } catch (cause) {
          sourceFileState = isNotFound(cause) ? "absent" : "unknown";
          throw cause;
        }
        const sourceStats = await source.stat();
        const expectedSourceIdentity = stagedIdentities.get(handle);
        if (
          expectedSourceIdentity !== undefined &&
          !sameFileIdentity(expectedSourceIdentity, sourceStats)
        ) {
          sourceFileState = "unknown";
          throw new Error("The staged source file was replaced before it was cloned.");
        }
        validateSourceFileSize(sourceStats.size);
        await source.sync();
        await beforeStagedCloneLink?.(sourcePath);

        for (let attempt = 0; attempt < MAX_STAGED_ALLOCATION_ATTEMPTS; attempt += 1) {
          const candidate = createStagedHandle(generateBytes);
          try {
            // link() supplies no-replace allocation and preserves the immutable
            // staged bytes without reopening caller input.
            await linkClone(candidate);
            await beforeStagedCloneCleanup?.(stagingPath(candidate));
            const clonedAfterCleanupRace = await lstat(stagingPath(candidate));
            if (
              targetIdentity === undefined ||
              !sameFileIdentity(targetIdentity, clonedAfterCleanupRace)
            ) {
              throw new Error("The cloned staged document file changed before cleanup.");
            }
            const sourceAtLink = await source.stat();
            if (
              !sameFileIdentity(sourceStats, sourceAtLink) ||
              sourceAtLink.size !== sourceStats.size
            ) {
              sourceFileState = "unknown";
              throw new Error("The staged source file changed while it was being cloned.");
            }
            break;
          } catch (cause) {
            if (errorCode(cause) !== "EEXIST") {
              throw cause;
            }
          }
        }

        if (targetHandle === undefined) {
          // Keep deterministic random seams useful while retaining a system
          // random fallback for the private clone allocation.
          for (let attempt = 0; attempt < MAX_STAGED_ALLOCATION_ATTEMPTS; attempt += 1) {
            const candidate = createStagedHandle(cryptoRandomBytes);
            try {
              await linkClone(candidate);
              await beforeStagedCloneCleanup?.(stagingPath(candidate));
              const clonedAfterCleanupRace = await lstat(stagingPath(candidate));
              if (
                targetIdentity === undefined ||
                !sameFileIdentity(targetIdentity, clonedAfterCleanupRace)
              ) {
                throw new Error("The cloned staged document file changed before cleanup.");
              }
              const sourceAtLink = await source.stat();
              if (
                !sameFileIdentity(sourceStats, sourceAtLink) ||
                sourceAtLink.size !== sourceStats.size
              ) {
                sourceFileState = "unknown";
                throw new Error("The staged source file changed while it was being cloned.");
              }
              break;
            } catch (cause) {
              if (errorCode(cause) !== "EEXIST") {
                throw cause;
              }
            }
          }
        }
        if (targetHandle === undefined) {
          throw new Error("Could not allocate a unique cloned staged document file handle.");
        }
        await syncDirectory(stagingDir);
        await source.close();
        source = undefined;
        await removeFinalizationLockDirectory(lockPath, lockLease);
        lockLease = undefined;
        lockOwned = false;
        finalizationLockState = "absent";
        await syncDirectory(stagingDir);
        return targetHandle;
      } catch (cause) {
        await source?.close().catch((closeError) => {
          cleanupCause ??= closeError;
        });
        source = undefined;
        if (targetCreated && targetHandle !== undefined) {
          try {
            if (targetIdentity === undefined) {
              throw new Error("The cloned staged file identity was unavailable for cleanup.");
            }
            const removed = await discardEntry(stagingDir, targetHandle, targetIdentity);
            stagedIdentities.delete(targetHandle);
            if (!removed) {
              clonedFileState = "absent";
            } else {
              targetCreated = false;
              clonedFileState = "absent";
              await syncDirectory(stagingDir);
            }
          } catch (targetCleanupError) {
            if (isNotFound(targetCleanupError)) {
              clonedFileState = "absent";
            } else {
              // Never unlink a path whose identity no longer matches the link
              // made by this clone. It may now belong to a replacement handle.
              clonedFileState = "unknown";
              cleanupCause ??= targetCleanupError;
            }
          }
        }
        if (lockOwned) {
          try {
            await removeFinalizationLockDirectory(lockPath, lockLease);
            lockLease = undefined;
            lockOwned = false;
            finalizationLockState = "absent";
          } catch (lockCleanupError) {
            if (isNotFound(lockCleanupError)) {
              lockLease = undefined;
              lockOwned = false;
              finalizationLockState = "absent";
            } else {
              finalizationLockState = "retained";
              cleanupCause ??= lockCleanupError;
            }
          }
        }
        throw new DocumentFileCloneError({
          handle,
          ...(targetHandle === undefined ? {} : { clonedHandle: targetHandle }),
          sourceFileState,
          clonedFileState,
          finalizationLockState,
          cause,
          ...(cleanupCause === undefined ? {} : { cleanupCause }),
          message: `Could not clone staged document file ${handle}: ${describe(cause)}${cleanupCause === undefined ? "" : `; cleanup also failed: ${describe(cleanupCause)}`}`,
        });
      }
    } finally {
      releaseOperation();
    }
  };

  const discardStagedFile = async (handleValue: StagedDocumentFileHandle) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const handle = validateStagedHandle(handleValue);
      const lockPath = entryPath(stagingDir, `.${handle}.lock`);
      let lockLease: FinalizationLockLease | undefined;
      let lockOwned = false;
      let stagedFileState: DocumentFileResourceState = "retained";
      let finalizationLockState: DocumentFileResourceState = "absent";
      let removed = false;
      let cleanupCause: unknown;

      try {
        // Taking the same lock as finalization makes compensation safe when a
        // caller accidentally shares a handle with another finalizer. A busy
        // lock is retained for that owner and is reported as an orphan rather
        // than guessed at or removed.
        lockLease = await acquireFinalizationLock(
          lockPath,
          now,
          beforeFinalizationLockRecoveryClaim
        );
        lockOwned = true;
        finalizationLockState = "retained";
        await syncDirectory(stagingDir);
        try {
          const expectedIdentity = stagedIdentities.get(handle);
          if (expectedIdentity === undefined) {
            try {
              await lstat(stagingPath(handle));
              throw new Error("The staged document file identity was unavailable for discard.");
            } catch (cause) {
              if (isNotFound(cause)) {
                removed = false;
                stagedFileState = "absent";
              } else {
                throw cause;
              }
            }
          } else {
            removed = await discardEntry(stagingDir, handle, expectedIdentity);
            stagedFileState = "absent";
            stagedIdentities.delete(handle);
          }
        } catch (cause) {
          if (isNotFound(cause)) {
            stagedFileState = "absent";
          } else {
            stagedFileState = "unknown";
            throw cause;
          }
        }
        if (removed) {
          await syncDirectory(stagingDir);
        }
        await removeFinalizationLockDirectory(lockPath, lockLease);
        lockLease = undefined;
        lockOwned = false;
        finalizationLockState = "absent";
        await syncDirectory(stagingDir);
        return removed;
      } catch (cause) {
        if (cause instanceof FinalizationLockBusyError) {
          finalizationLockState = "retained";
        } else if (finalizationLockState === "absent") {
          finalizationLockState = "unknown";
        }
        if (lockOwned) {
          try {
            await removeFinalizationLockDirectory(lockPath, lockLease);
            lockLease = undefined;
            lockOwned = false;
            finalizationLockState = "absent";
          } catch (lockCleanupError) {
            if (isNotFound(lockCleanupError)) {
              lockLease = undefined;
              lockOwned = false;
              finalizationLockState = "absent";
            } else {
              finalizationLockState = "retained";
              cleanupCause = lockCleanupError;
            }
          }
        }
        throw new DocumentFileDiscardError({
          handle,
          stagedFileState,
          finalizationLockState,
          cause,
          ...(cleanupCause === undefined ? {} : { cleanupCause }),
          message: `Could not discard staged document file ${handle}: ${describe(cause)}${cleanupCause === undefined ? "" : `; cleanup also failed: ${describe(cleanupCause)}`}`,
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
      return await withDocumentMutex(documentId, async () => {
        const path = documentPath(documentId);
        let file: Awaited<ReturnType<typeof open>> | undefined;
        let targetLease: FinalizationLockLease | undefined;
        let readReference: ReadReferenceLease | undefined;
        let stream: ReadStream | undefined;
        try {
          // The target lock closes the gap between the metadata-gated open and
          // publishing a cross-instance read reference. A peer deletion either
          // wins first (and this open fails) or observes the reference after it
          // releases the same lock.
          targetLease = await acquireTargetLock(documentId);
          await syncDirectory(stagingDir);
          file = await openWithoutFollowingLinks(path, constants.O_RDONLY, path, false);
          ensureTrustedRoots();
          readReference = await createReadReference(stagingDir, documentId, now);
          await syncDirectory(stagingDir);
          stream = file.createReadStream({ autoClose: true });
          let released = false;
          const releaseRead = () => {
            if (released) {
              return;
            }
            released = true;
            if (readReference !== undefined) {
              releaseReadReference(readReference);
              readReference = undefined;
            }
          };
          stream.once("close", releaseRead);
          stream.once("error", releaseRead);
          await releaseTargetLock(documentId, targetLease);
          targetLease = undefined;
          return stream;
        } catch (cause) {
          if (readReference !== undefined) {
            releaseReadReference(readReference);
            readReference = undefined;
          }
          stream?.destroy();
          await file?.close().catch(() => undefined);
          if (targetLease !== undefined) {
            await removeFinalizationLockDirectory(targetLockPath(documentId), targetLease).catch(
              () => undefined
            );
          }
          if (cause instanceof DocumentFileNotRegularError) {
            throw cause;
          }
          throw new DocumentFileReadError({
            id: documentId,
            cause,
            message: `Could not open document file ${documentId}: ${describe(cause)}`,
          });
        }
      });
    } finally {
      releaseOperation();
    }
  };

  const deleteDocumentFileUnlocked = async (
    id: string,
    expectedTarget?: DocumentFileTargetCapability,
    shouldDelete: (targetExists: boolean) => boolean | Promise<boolean> = () => true
  ) => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const documentId = validateDocumentId(id);
      const path = documentPath(documentId);
      const targetLockPath = entryPath(stagingDir, `.${documentId}.target.lock`);
      let targetLockLease: FinalizationLockLease | undefined;
      let targetLockOwned = false;
      let targetLockState: DocumentFileResourceState = "absent";
      let targetState: DocumentFileResourceState = "unknown";
      let result = false;
      let failure: unknown;

      try {
        try {
          targetLockLease = await acquireFinalizationLock(
            targetLockPath,
            now,
            beforeFinalizationLockRecoveryClaim
          );
        } catch (cause) {
          targetLockState = cause instanceof FinalizationLockBusyError ? "retained" : "unknown";
          throw cause;
        }
        targetLockOwned = true;
        targetLockState = "retained";
        await syncDirectory(stagingDir);
        let stats: Stats | undefined;
        try {
          stats = await lstat(path);
        } catch (cause) {
          if (!isNotFound(cause)) {
            throw cause;
          }
          targetState = "absent";
          if (await activeReadReferenceExists(documentId)) {
            throw new DocumentFileReadActiveError({
              id: documentId,
              message: `Document ${documentId} is being read and cannot be reconciled yet.`,
            });
          }
          await shouldDelete(false);
        }
        if (stats !== undefined) {
          targetState = "retained";
          if (stats.isSymbolicLink() || !stats.isFile()) {
            throw regularFileError(path);
          }
          if (await activeReadReferenceExists(documentId)) {
            throw new DocumentFileReadActiveError({
              id: documentId,
              message: `Document ${documentId} is being read and cannot be deleted yet.`,
            });
          }
          const approved = await shouldDelete(true);
          if (approved) {
            if (expectedTarget !== undefined) {
              if (
                expectedTarget.id !== documentId ||
                !sameFileIdentity(expectedTarget.identity, stats)
              ) {
                throw new Error("The document target was replaced before identity-safe deletion.");
              }
            }
            await beforeDocumentTargetDelete?.(path);
            const targetAfterRace = await lstat(path);
            if (
              targetAfterRace.isSymbolicLink() ||
              !targetAfterRace.isFile() ||
              !sameFileIdentity(stats, targetAfterRace) ||
              (expectedTarget !== undefined &&
                !sameFileIdentity(expectedTarget.identity, targetAfterRace))
            ) {
              throw new Error("The document target was replaced before identity-safe deletion.");
            }
            const removed = await discardEntry(
              documentsDir,
              `${documentId}.html`,
              expectedTarget?.identity ?? stats
            );
            result = removed;
            targetState = "absent";
            if (removed) {
              await syncDirectory(documentsDir);
            }
          }
        }
      } catch (cause) {
        failure = cause;
        if (isNotFound(cause)) {
          targetState = "absent";
        } else if (targetState === "retained") {
          targetState = "unknown";
        }
      }

      if (targetLockOwned) {
        try {
          await removeFinalizationLockDirectory(targetLockPath, targetLockLease);
          targetLockLease = undefined;
          targetLockOwned = false;
          targetLockState = "absent";
          await syncDirectory(stagingDir);
        } catch (lockCleanupCause) {
          // If removal returned but directory synchronization failed, the
          // current pathname is no longer known to contain the lock, but its
          // durable state is ambiguous. Do not report that as definitely
          // retained.
          targetLockState = targetLockOwned ? "retained" : "unknown";
          failure =
            failure === undefined
              ? lockCleanupCause
              : new AggregateError([failure, lockCleanupCause], "Document target cleanup failed.");
        }
      }

      if (failure === undefined) {
        return result;
      }
      if (isNotFound(failure) && targetLockState === "absent") {
        return result;
      }
      if (failure instanceof DocumentFileNotRegularError) {
        throw failure;
      }
      throw new DocumentFileDeleteError({
        id: documentId,
        targetState,
        targetLockState,
        cause: failure,
        message: `Could not delete document file ${documentId}: ${describe(failure)}`,
      });
    } finally {
      releaseOperation();
    }
  };

  const deleteDocumentFile = async (id: string, expectedTarget?: DocumentFileTargetCapability) => {
    const documentId = validateDocumentId(id);
    return withDocumentMutex(documentId, () =>
      deleteDocumentFileUnlocked(documentId, expectedTarget)
    );
  };

  const deleteDocumentFileIf = async (
    id: string,
    shouldDelete: (targetExists: boolean) => boolean | Promise<boolean>
  ) => {
    const documentId = validateDocumentId(id);
    return withDocumentMutex(documentId, () =>
      deleteDocumentFileUnlocked(documentId, undefined, shouldDelete)
    );
  };

  const listDocumentFiles = async () => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const entries = await readdir(entryPath(documentsDir, ""));
      const files: DocumentFileObservation[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".html")) {
          continue;
        }
        const candidate = entry.slice(0, -".html".length);
        let documentId: string;
        try {
          documentId = validateDocumentId(candidate);
        } catch {
          continue;
        }
        const path = entryPath(documentsDir, entry);
        let stats: Stats;
        try {
          stats = await lstat(path);
        } catch (cause) {
          if (isNotFound(cause)) {
            continue;
          }
          throw cause;
        }
        if (stats.isFile() && !stats.isSymbolicLink()) {
          files.push({ id: documentId, size: stats.size, modifiedAt: stats.mtimeMs });
        }
      }
      return files.sort((left, right) => left.id.localeCompare(right.id));
    } finally {
      releaseOperation();
    }
  };

  const isFreshResource = async (path: string) => {
    try {
      const stats = await lstat(path);
      return (
        stats.isFile() &&
        !stats.isSymbolicLink() &&
        stats.mtimeMs > now() - DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS
      );
    } catch (cause) {
      if (isNotFound(cause)) {
        return false;
      }
      // A non-regular or uninspectable resource is retained. It must not be
      // used as evidence that a lock is stale while a publisher may still own
      // the corresponding pathname.
      return true;
    }
  };

  const reconcileLock = async (lockPath: string, resourcePath?: string) => {
    // The directory listing is only a candidate set. Recheck the associated
    // resource immediately before stale-lock recovery so a long reconciliation
    // pass cannot remove a lock for a publisher that has just created a fresh
    // target/staged file.
    if (resourcePath !== undefined && (await isFreshResource(resourcePath))) {
      return false;
    }
    let lease: FinalizationLockLease | undefined;
    try {
      lease = await acquireFinalizationLock(lockPath, now, beforeFinalizationLockRecoveryClaim);
    } catch (cause) {
      if (cause instanceof FinalizationLockBusyError) {
        return false;
      }
      throw cause;
    }
    if (resourcePath !== undefined && (await isFreshResource(resourcePath))) {
      await removeFinalizationLockDirectory(lockPath, lease);
      await syncDirectory(stagingDir);
      return true;
    }
    await removeFinalizationLockDirectory(lockPath, lease);
    await syncDirectory(stagingDir);
    return true;
  };

  const reconcileDocumentFiles = async () => {
    const releaseOperation = beginOperation();
    try {
      ensureTrustedRoots();
      const entries = await readdir(entryPath(stagingDir, ""));
      let stagedFilesRemoved = 0;
      let readReferencesRemoved = 0;
      let finalizationLocksRemoved = 0;
      let retainedEntries = 0;
      const handledLocks = new Set<string>();
      for (const entry of entries) {
        if (isValidStagedHandle(entry)) {
          continue;
        }
        if (readReferenceEntry(entry) !== undefined) {
          continue;
        }
        if (entry.startsWith(".") && entry.endsWith(".lock")) {
          const body = entry.slice(1, -".lock".length);
          if (isValidStagedHandle(body)) {
            continue;
          }
          if (body.endsWith(".target")) {
            try {
              validateDocumentId(body.slice(0, -".target".length));
              continue;
            } catch {
              // An unknown lock name is retained and reported below.
            }
          }
        }
        retainedEntries += 1;
      }

      let removedReadReference = false;
      for (const entry of entries) {
        if (readReferenceEntry(entry) === undefined) {
          continue;
        }
        const path = entryPath(stagingDir, entry);
        try {
          const observation = await readReadReference(path);
          if (
            observation === undefined ||
            observation.metadata.owner.host !== LOCAL_HOSTNAME ||
            isProcessAlive(observation.metadata.owner.pid)
          ) {
            // Malformed markers, foreign owners, and live local owners are
            // retained. Only a marker whose local owner is definitely dead
            // can be reclaimed after a crashed read.
            retainedEntries += 1;
            continue;
          }
          const fresh = await readReadReference(path);
          if (
            fresh === undefined ||
            !sameFileIdentity(observation.identity, fresh.identity) ||
            fresh.metadata.owner.host !== LOCAL_HOSTNAME ||
            fresh.metadata.owner.pid !== observation.metadata.owner.pid ||
            fresh.metadata.acquiredAt !== observation.metadata.acquiredAt ||
            isProcessAlive(fresh.metadata.owner.pid)
          ) {
            retainedEntries += 1;
            continue;
          }
          if (await discardEntry(stagingDir, entry, fresh.identity)) {
            readReferencesRemoved += 1;
            removedReadReference = true;
          }
        } catch {
          retainedEntries += 1;
        }
      }
      if (removedReadReference) {
        await syncDirectory(stagingDir);
      }

      for (const entry of entries) {
        if (!isValidStagedHandle(entry)) {
          continue;
        }
        const path = stagingPath(entry);
        const lockPath = entryPath(stagingDir, `.${entry}.lock`);
        let lockExisted = false;
        try {
          await lstat(lockPath);
          lockExisted = true;
        } catch (cause) {
          if (!isNotFound(cause)) {
            retainedEntries += 1;
            continue;
          }
        }
        let stagedStats: Stats | undefined;
        try {
          const stats = await lstat(path);
          if (stats.isFile() && !stats.isSymbolicLink()) {
            stagedStats = stats;
            stagedIdentities.set(entry, stats);
          }
        } catch (cause) {
          if (!isNotFound(cause)) {
            retainedEntries += 1;
          }
        }
        if (stagedStats !== undefined && (await isFreshResource(path))) {
          retainedEntries += 1;
          continue;
        }
        try {
          const removed = await discardStagedFile(entry);
          if (removed) {
            stagedFilesRemoved += 1;
          }
          handledLocks.add(`.${entry}.lock`);
          if (
            lockExisted &&
            (await lstat(lockPath).catch((cause) => (isNotFound(cause) ? undefined : cause))) ===
              undefined
          ) {
            finalizationLocksRemoved += 1;
          }
        } catch {
          retainedEntries += 1;
        }
      }

      for (const entry of entries) {
        let lockId: string | undefined;
        let lockPath: string | undefined;
        if (entry.startsWith(".") && entry.endsWith(".lock")) {
          const body = entry.slice(1, -".lock".length);
          if (isValidStagedHandle(body)) {
            lockId = body;
            lockPath = entryPath(stagingDir, entry);
          } else if (body.endsWith(".target")) {
            const targetId = body.slice(0, -".target".length);
            try {
              lockId = validateDocumentId(targetId);
              lockPath = entryPath(stagingDir, entry);
            } catch {
              // Unknown lock names are retained rather than guessed at.
            }
          }
        }
        if (lockPath === undefined || handledLocks.has(entry)) {
          continue;
        }
        try {
          if (lockId !== undefined && isValidStagedHandle(lockId)) {
            const stagedPath = stagingPath(lockId);
            if (await isFreshResource(stagedPath)) {
              retainedEntries += 1;
            } else {
              const removed = await discardStagedFile(lockId);
              if (removed) {
                stagedFilesRemoved += 1;
              }
              if (
                (await lstat(lockPath).catch((cause) =>
                  isNotFound(cause) ? undefined : cause
                )) === undefined
              ) {
                finalizationLocksRemoved += 1;
              }
            }
          } else if (
            lockId !== undefined &&
            (await reconcileLock(lockPath, documentPath(lockId)))
          ) {
            finalizationLocksRemoved += 1;
          } else {
            retainedEntries += 1;
          }
          handledLocks.add(entry);
        } catch {
          retainedEntries += 1;
        }
      }

      return {
        stagedFilesRemoved,
        readReferencesRemoved,
        finalizationLocksRemoved,
        retainedEntries,
      } satisfies DocumentFileReconciliationResult;
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
    deleteDocumentFileIf,
    listDocumentFiles,
    reconcileDocumentFiles,
    cloneStagedFile,
    discardStagedFile,
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
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.beforeFinalizationLockRecoveryClaim === undefined
        ? {}
        : { beforeFinalizationLockRecoveryClaim: options.beforeFinalizationLockRecoveryClaim }),
      ...(options.beforeStagedCloneLink === undefined
        ? {}
        : { beforeStagedCloneLink: options.beforeStagedCloneLink }),
      ...(options.beforeStagedCloneCleanup === undefined
        ? {}
        : { beforeStagedCloneCleanup: options.beforeStagedCloneCleanup }),
      ...(options.beforeStagedSourceCopy === undefined
        ? {}
        : { beforeStagedSourceCopy: options.beforeStagedSourceCopy }),
      ...(options.beforeStagedSourceCleanup === undefined
        ? {}
        : { beforeStagedSourceCleanup: options.beforeStagedSourceCleanup }),
      ...(options.beforeFinalizationTargetInspection === undefined
        ? {}
        : { beforeFinalizationTargetInspection: options.beforeFinalizationTargetInspection }),
      ...(options.beforeFinalizationTargetCleanup === undefined
        ? {}
        : { beforeFinalizationTargetCleanup: options.beforeFinalizationTargetCleanup }),
      ...(options.beforePostPublicationStagingDirectorySync === undefined
        ? {}
        : {
            beforePostPublicationStagingDirectorySync:
              options.beforePostPublicationStagingDirectorySync,
          }),
      ...(options.beforeDocumentTargetDelete === undefined
        ? {}
        : { beforeDocumentTargetDelete: options.beforeDocumentTargetDelete }),
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
