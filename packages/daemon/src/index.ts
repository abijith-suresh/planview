import { randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
  chmod,
  type FileHandle,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection, type Socket } from "node:net";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  resolveAppDataPaths,
  V1_CLEANUP_INTERVAL_HOURS,
  V1_MAX_HTML_SIZE_BYTES,
  V1_PORT,
  validateDocumentId,
} from "@planview/core";
import {
  createDocumentCleanupCoordinator,
  createDocumentPublicationCoordinator,
  type DocumentCleanupFailure,
  type DocumentCleanupResult,
  type DocumentFileStore,
  type DocumentPublicationCoordinator,
  DocumentPublicationNotFoundError,
  DocumentPublicationReadError,
  type MetadataStore,
  openDocumentFileStore,
  openStorage,
} from "@planview/storage";
import { Data, Effect } from "effect";

export const DAEMON_HOST = "127.0.0.1" as const;
/** The v1 daemon port is fixed for the public CLI. */
export const DAEMON_PORT = V1_PORT;
export const DAEMON_STARTUP_LEASE_MS = 30_000;
export const DAEMON_STARTUP_GRACE_MS = 5_000;
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;
/** In-flight mutations get a short drain window before shutdown cancellation. */
export const DAEMON_SHUTDOWN_OPERATION_GRACE_MS = 4_000;
export const DAEMON_DESCRIPTOR_VERSION = 1;
export const DAEMON_DESCRIPTOR_NAME = "daemon.json";
export const DAEMON_LOCK_NAME = "lifecycle.lock";
export const DAEMON_SECRET_HEADER = "x-planview-secret";
export const DAEMON_READY_PATH = "/__planview/ready";
const DAEMON_STARTUP_ACK_PATH = "/__planview/startup-ack";
export const DAEMON_STATUS_PATH = "/__planview/status";
export const DAEMON_SHUTDOWN_PATH = "/__planview/shutdown";
export const DAEMON_PUBLISH_PATH = "/__planview/publish";
export const DAEMON_CLEAN_PATH = "/__planview/clean";
export const DAEMON_CLEANUP_INTERVAL_MS = V1_CLEANUP_INTERVAL_HOURS * 60 * 60 * 1_000;
const DAEMON_LOCK_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REQUEST_TIMEOUT_MS = 1_000;
/** Slow consumers are allowed to backpressure, but not to remain completely idle forever. */
export const DAEMON_DOCUMENT_READ_IDLE_TIMEOUT_MS = 30_000;
/** An absolute bound prevents a peer from retaining a read lease indefinitely. */
export const DAEMON_DOCUMENT_READ_MAX_DURATION_MS = 10 * 60_000;
export const DAEMON_DOCUMENT_READ_QUEUE_TIMEOUT_MS = 30_000;
/** Read admission is bounded so stalled clients cannot grow an unbounded queue. */
export const DAEMON_MAX_ACTIVE_DOCUMENT_READS = 64;
export const DAEMON_MAX_QUEUED_DOCUMENT_READS = 128;
export const DAEMON_CLEANUP_TIMEOUT_MIN_MS = 10_000;
export const DAEMON_CLEANUP_TIMEOUT_MAX_MS = 60_000;
const CLEANUP_DOCUMENT_BUDGET_MS = 20;
const CLEANUP_BYTE_BUDGET_BYTES_PER_MS = 128 * 1024;
// Publication is a synchronous request: the 201 response is sent only after
// the immutable file and metadata row have both committed. Give the largest
// allowed source a bounded timeout based on a conservative copy rate rather
// than letting the general lifecycle timeout make the result ambiguous.
export const DAEMON_PUBLISH_TIMEOUT_MIN_MS = 5_000;
export const DAEMON_PUBLISH_TIMEOUT_MAX_MS = 60_000;
const PUBLISH_COPY_RATE_BYTES_PER_SECOND = 1024 * 1024;
const STARTUP_TIMEOUT_MS = DAEMON_CLEANUP_TIMEOUT_MAX_MS;
// A shutdown deadline is enforced by the daemon process. This margin lets a
// lifecycle caller observe descriptor removal when the event loop is delayed.
const SHUTDOWN_POLL_GRACE_MS = 2_000;
// Leave a small, explicit window for forced socket closure before the process
// fallback. Both timers use the same absolute shutdown deadline below.
const SHUTDOWN_FORCE_CLOSE_MARGIN_MS = 250;
// Lifecycle calls can legitimately queue behind a slow shutdown/startup. Keep
// lock acquisition bounded, but long enough for the concurrent lifecycle
// stress and for several operations to pass through the same lock.
const LIFECYCLE_LOCK_WAIT_MS = 60_000;
const STARTUP_POLL_MS = 50;
const MAX_PUBLISH_REQUEST_BYTES = 16 * 1024;
const LOCAL_HOSTNAME = hostname();
const TEST_PORT_ENV = "PLANVIEW_TEST_DAEMON_PORT";
const TEST_ADOPTION_PAUSE_ENV = "PLANVIEW_TEST_DAEMON_ADOPTION_PAUSE_MS";
const TEST_PUBLISH_PAUSE_ENV = "PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_MS";
const TEST_PUBLISH_PAUSE_ONCE_ENV = "PLANVIEW_TEST_DAEMON_PUBLISH_PAUSE_ONCE";
const TEST_UNCOOPERATIVE_PUBLISH_ENV = "PLANVIEW_TEST_DAEMON_UNCOOPERATIVE_PUBLISH";
const TEST_CLEANUP_PAUSE_ENV = "PLANVIEW_TEST_DAEMON_CLEANUP_PAUSE_MS";
const LIFECYCLE_TOKEN_ENV = "PLANVIEW_DAEMON_LIFECYCLE_TOKEN";
const isTestProcess = () => {
  const { NODE_ENV } = process.env;
  return NODE_ENV === "test";
};
let testPublishPauseConsumed = false;

export type DaemonPathOptions = Readonly<{
  readonly appDataDir?: string;
  readonly runtimeDir?: string;
}>;

export type DaemonPaths = Readonly<{
  readonly appDataDir: string;
  readonly runtimeDir: string;
  readonly descriptorPath: string;
  readonly lockPath: string;
}>;

export type DaemonConfig = Readonly<{
  readonly appDataDir: string;
  readonly runtimeDir: string;
  readonly host: typeof DAEMON_HOST;
  readonly port: number;
}>;

export type DaemonConfigOptions = DaemonPathOptions;

/** @internal Test-only configuration; the public daemon port remains fixed. */
export type DaemonTestConfigOptions = DaemonPathOptions &
  Readonly<{
    readonly port: number;
  }>;

export type RuntimeDescriptor = Readonly<{
  readonly version: typeof DAEMON_DESCRIPTOR_VERSION;
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly secret: string;
  readonly startedAt: number;
}>;

type LockDescriptor = Readonly<{
  readonly version: typeof DAEMON_LOCK_VERSION;
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: number;
}>;

type FileObservation = Readonly<{
  readonly stats: Stats;
  readonly contents: string;
}>;

type LockObservation = Readonly<{
  readonly stats: Stats;
  readonly observation: FileObservation | undefined;
  readonly protected: boolean;
}>;

export class DaemonPathError extends Data.TaggedError("DaemonPathError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class DaemonStartupBusyError extends Data.TaggedError("DaemonStartupBusyError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class DaemonAlreadyRunningError extends Data.TaggedError("DaemonAlreadyRunningError")<{
  readonly pid: number;
  readonly message: string;
}> {}

export class DaemonPortInUseError extends Data.TaggedError("DaemonPortInUseError")<{
  readonly host: string;
  readonly port: number;
  readonly message: string;
}> {}

export class DaemonDescriptorError extends Data.TaggedError("DaemonDescriptorError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class DaemonDescriptorEndpointMismatchError extends Data.TaggedError(
  "DaemonDescriptorEndpointMismatchError"
)<{
  readonly path: string;
  readonly descriptorHost: string;
  readonly descriptorPort: number;
  readonly configHost: string;
  readonly configPort: number;
  readonly message: string;
}> {}

export class DaemonRequestError extends Data.TaggedError("DaemonRequestError")<{
  readonly path: string;
  readonly cause: unknown;
  readonly message: string;
}> {}

export type DaemonState =
  | Readonly<{ readonly state: "stopped" }>
  | Readonly<{
      readonly state: "running";
      readonly descriptor: RuntimeDescriptor;
      readonly status: DaemonStatusPayload;
    }>;

export type DaemonStatusPayload = Readonly<{
  readonly state: "running";
  readonly pid: number;
  readonly host: string;
  readonly port: number;
  readonly startedAt: number;
}>;

export type PublishedDaemonDocument = Readonly<{
  readonly id: import("@planview/core").DocumentId;
  readonly descriptor: RuntimeDescriptor;
  readonly reused: boolean;
}>;

export type CleanedDaemonDocuments = Readonly<{
  readonly descriptor: RuntimeDescriptor;
  readonly reused: boolean;
  readonly result: DocumentCleanupResult;
}>;

export type RetrieveDaemonOptions = Readonly<{
  readonly daemonScriptPath: string;
  readonly documentId: import("@planview/core").DocumentId;
  readonly onChunk: (chunk: Uint8Array) => void | Promise<void>;
}>;

type DaemonResponse = Readonly<{
  readonly statusCode: number;
  readonly body: string;
}>;

const publishRequestTimeout = (sourceSizeBytes: number | undefined) => {
  const size =
    typeof sourceSizeBytes === "number" && Number.isSafeInteger(sourceSizeBytes)
      ? Math.min(Math.max(sourceSizeBytes, 0), V1_MAX_HTML_SIZE_BYTES)
      : V1_MAX_HTML_SIZE_BYTES;
  const copyMilliseconds = Math.ceil((size / PUBLISH_COPY_RATE_BYTES_PER_SECOND) * 1_000);
  return Math.min(
    DAEMON_PUBLISH_TIMEOUT_MAX_MS,
    Math.max(DAEMON_PUBLISH_TIMEOUT_MIN_MS, DAEMON_PUBLISH_TIMEOUT_MIN_MS + copyMilliseconds)
  );
};

type LifecycleLock = Readonly<{
  readonly token: string;
  readonly release: () => Promise<void>;
}>;

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const envValue = (env: Readonly<Record<string, string | undefined>>, ...keys: string[]) => {
  for (const key of keys) {
    const value = env[key];
    if (value !== undefined && value !== "") {
      return value;
    }
  }
  return undefined;
};

const validateAbsolutePath = (value: string, label: string) => {
  if (!isAbsolute(value) || resolve(value) === parse(resolve(value)).root) {
    throw new DaemonPathError({
      path: value,
      message: `${label} must be an absolute path below a filesystem root.`,
    });
  }
  return resolve(value);
};

const validatePort = (port: number) => {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("The daemon port must be an integer between 1 and 65535.");
  }
  return port;
};

const isContainedPath = (root: string, child: string) => {
  const childRelativePath = relative(root, child);
  return (
    childRelativePath !== "" &&
    !childRelativePath.startsWith("..") &&
    !isAbsolute(childRelativePath)
  );
};

export const resolveDaemonPaths = (options: DaemonPathOptions = {}) => {
  const appDataDir = validateAbsolutePath(
    options.appDataDir ?? resolveAppDataPaths().appDataDir,
    "The Planview app-data directory"
  );
  const runtimeDir = validateAbsolutePath(
    options.runtimeDir ?? join(appDataDir, "runtime"),
    "The Planview runtime directory"
  );
  if (!isContainedPath(appDataDir, runtimeDir)) {
    throw new DaemonPathError({
      path: runtimeDir,
      message: "The Planview runtime directory must be contained below app-data.",
    });
  }

  return {
    appDataDir,
    runtimeDir,
    descriptorPath: join(runtimeDir, DAEMON_DESCRIPTOR_NAME),
    lockPath: join(runtimeDir, DAEMON_LOCK_NAME),
  } satisfies DaemonPaths;
};

const resolveConfig = (
  options: DaemonPathOptions,
  env: Readonly<Record<string, string | undefined>>,
  port: number
) => {
  const appDataDir =
    options.appDataDir ?? envValue(env, "PLANVIEW_APP_DATA_DIR", "PLANVIEW_DATA_DIR");
  const runtimeDir = options.runtimeDir ?? envValue(env, "PLANVIEW_RUNTIME_DIR");
  const paths = resolveDaemonPaths({
    ...(appDataDir === undefined ? {} : { appDataDir }),
    ...(runtimeDir === undefined ? {} : { runtimeDir }),
  });

  return {
    ...paths,
    host: DAEMON_HOST,
    port: validatePort(port),
  } satisfies DaemonConfig & DaemonPaths;
};

export const resolveDaemonConfig = (
  options: DaemonConfigOptions = {},
  env: Readonly<Record<string, string | undefined>> = process.env
) => resolveConfig(options, env, DAEMON_PORT);

/** @internal Test-only port injection; production configuration always uses 4777. */
export const resolveDaemonConfigForTest = (
  options: DaemonTestConfigOptions,
  env: Readonly<Record<string, string | undefined>> = process.env
) => resolveConfig(options, env, options.port);

const isNotFound = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const isAlreadyExists = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST";

const isOwnedByCurrentUser = (stats: Stats) =>
  process.platform === "win32" ||
  process.getuid?.() === undefined ||
  stats.uid === process.getuid?.();

const isPrivateFileStats = (stats: Stats) =>
  stats.isFile() &&
  (process.platform === "win32" || (isOwnedByCurrentUser(stats) && (stats.mode & 0o077) === 0));

const ensurePrivateDirectory = async (path: string) => {
  try {
    await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    const directory = await lstat(path);
    if (directory.isSymbolicLink()) {
      throw new DaemonPathError({
        path,
        message: "The daemon path must not be a symbolic link.",
      });
    }
    if (!directory.isDirectory()) {
      throw new DaemonPathError({
        path,
        message: "The daemon path exists but is not a directory.",
      });
    }
    if (process.platform !== "win32") {
      if (!isOwnedByCurrentUser(directory)) {
        throw new DaemonPathError({
          path,
          message: "The daemon path must be owned by the current user.",
        });
      }
      await chmod(path, PRIVATE_DIRECTORY_MODE);
      const privateDirectory = await lstat(path);
      if (!isOwnedByCurrentUser(privateDirectory) || (privateDirectory.mode & 0o077) !== 0) {
        throw new DaemonPathError({
          path,
          message: "The daemon path must be owned by the current user and private.",
        });
      }
    }
  } catch (cause) {
    if (cause instanceof DaemonPathError) {
      throw cause;
    }
    throw new DaemonPathError({
      path,
      message: `Could not prepare the daemon directory: ${describe(cause)}`,
    });
  }
};

const ensureRuntimeContained = async (paths: DaemonPaths) => {
  try {
    const [appDataRealPath, runtimeRealPath] = await Promise.all([
      realpath(paths.appDataDir),
      realpath(paths.runtimeDir),
    ]);
    if (!isContainedPath(appDataRealPath, runtimeRealPath)) {
      throw new DaemonPathError({
        path: paths.runtimeDir,
        message: "The Planview runtime directory must remain contained below app-data.",
      });
    }
  } catch (cause) {
    if (cause instanceof DaemonPathError) {
      throw cause;
    }
    throw new DaemonPathError({
      path: paths.runtimeDir,
      message: `Could not verify app-data containment: ${describe(cause)}`,
    });
  }
};

const readObservation = async (
  path: string,
  maxBytes: number
): Promise<FileObservation | undefined> => {
  let fileStats: Stats;
  try {
    fileStats = await lstat(path);
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
  if (!isPrivateFileStats(fileStats)) {
    return undefined;
  }
  const file = await open(
    path,
    process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW
  );
  try {
    const contents = await file.readFile({ encoding: "utf8" });
    if (Buffer.byteLength(contents, "utf8") > maxBytes) {
      return undefined;
    }
    return { stats: fileStats, contents };
  } finally {
    await file.close();
  }
};

const parseJson = (contents: string) => {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const recordValue = (record: Record<string, unknown>, key: string) => record[key];

const isValidDescriptor = (value: unknown): value is RuntimeDescriptor => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    recordValue(value, "version") === DAEMON_DESCRIPTOR_VERSION &&
    typeof recordValue(value, "pid") === "number" &&
    Number.isSafeInteger(recordValue(value, "pid")) &&
    (recordValue(value, "pid") as number) > 0 &&
    typeof recordValue(value, "host") === "string" &&
    (recordValue(value, "host") as string).length > 0 &&
    typeof recordValue(value, "port") === "number" &&
    Number.isInteger(recordValue(value, "port")) &&
    (recordValue(value, "port") as number) >= 1 &&
    (recordValue(value, "port") as number) <= 65_535 &&
    typeof recordValue(value, "secret") === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/.test(recordValue(value, "secret") as string) &&
    typeof recordValue(value, "startedAt") === "number" &&
    Number.isSafeInteger(recordValue(value, "startedAt")) &&
    (recordValue(value, "startedAt") as number) >= 0
  );
};

const isValidLock = (value: unknown): value is LockDescriptor => {
  if (!isRecord(value)) {
    return false;
  }
  return (
    recordValue(value, "version") === DAEMON_LOCK_VERSION &&
    typeof recordValue(value, "pid") === "number" &&
    Number.isSafeInteger(recordValue(value, "pid")) &&
    (recordValue(value, "pid") as number) > 0 &&
    typeof recordValue(value, "host") === "string" &&
    (recordValue(value, "host") as string).length > 0 &&
    typeof recordValue(value, "token") === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/.test(recordValue(value, "token") as string) &&
    typeof recordValue(value, "acquiredAt") === "number" &&
    Number.isSafeInteger(recordValue(value, "acquiredAt")) &&
    (recordValue(value, "acquiredAt") as number) >= 0
  );
};

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !(
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ESRCH"
    );
  }
};

const sameFile = (left: Stats, right: Stats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs;

const removeIfSame = async (path: string, observation: FileObservation) => {
  try {
    const current = await lstat(path);
    if (sameFile(observation.stats, current)) {
      await unlink(path);
    }
  } catch (cause) {
    if (!isNotFound(cause)) {
      throw cause;
    }
  }
};

const readDescriptorObservation = async (paths: DaemonPaths) => {
  let stats: Stats;
  try {
    stats = await lstat(paths.descriptorPath);
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: `Could not inspect the daemon descriptor: ${describe(cause)}`,
    });
  }

  if (!isPrivateFileStats(stats)) {
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: "The daemon descriptor exists but is not a private regular file.",
    });
  }

  try {
    const observation = await readObservation(paths.descriptorPath, 16 * 1024);
    if (observation !== undefined) {
      return observation;
    }

    // A valid descriptor can disappear between lstat and open during a normal
    // shutdown. Recheck before classifying an existing file as corrupt.
    try {
      await lstat(paths.descriptorPath);
    } catch (cause) {
      if (isNotFound(cause)) {
        return undefined;
      }
      throw cause;
    }
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: "The daemon descriptor exists but is not a private regular file.",
    });
  } catch (cause) {
    if (cause instanceof DaemonDescriptorError) {
      throw cause;
    }
    if (isNotFound(cause)) {
      return undefined;
    }
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: `Could not read the daemon descriptor securely: ${describe(cause)}`,
    });
  }
};

export const readDaemonDescriptor = async (paths: DaemonPaths) => {
  const observation = await readDescriptorObservation(paths);
  if (observation === undefined) {
    return undefined;
  }
  const parsed = parseJson(observation.contents);
  if (!isValidDescriptor(parsed)) {
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: "The daemon descriptor is malformed.",
    });
  }
  return parsed;
};

const readDescriptorForStartup = async (paths: DaemonPaths) => {
  const observation = await readDescriptorObservation(paths);
  if (observation === undefined) {
    return undefined;
  }
  const parsed = parseJson(observation.contents);
  if (!isValidDescriptor(parsed)) {
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: "The existing daemon descriptor is malformed; refusing to replace it.",
    });
  }
  return parsed;
};

const removeDeadDescriptor = async (paths: DaemonPaths, descriptor: RuntimeDescriptor) => {
  if (processIsAlive(descriptor.pid)) {
    return false;
  }
  const observation = await readObservation(paths.descriptorPath, 16 * 1024);
  if (observation !== undefined && isValidDescriptor(parseJson(observation.contents))) {
    await removeIfSame(paths.descriptorPath, observation);
  }
  return true;
};

const inspectLock = async (lockPath: string) => {
  try {
    const stats = await lstat(lockPath);
    if (!isPrivateFileStats(stats)) {
      return { stats, observation: undefined, protected: false };
    }
    // lstat and readObservation are separate operations. A contender can
    // remove a recovered lock in between them; ENOENT means that lock is gone,
    // not that a malformed lock should be retained until the deadline.
    const observation = await readObservation(lockPath, 16 * 1024);
    if (observation === undefined) {
      return undefined;
    }
    return { stats, observation, protected: true };
  } catch (cause) {
    if (isNotFound(cause)) {
      return undefined;
    }
    throw cause;
  }
};

const isPastLockLease = (timestamp: number) =>
  Number.isFinite(timestamp) &&
  timestamp <= Date.now() - DAEMON_STARTUP_LEASE_MS - DAEMON_STARTUP_GRACE_MS;

const isRecoverableLock = (observation: LockObservation, existing: unknown) => {
  if (isValidLock(existing)) {
    // A valid local owner is authoritative while its PID is alive. A dead
    // owner still gets the conservative lease window so a delegated daemon
    // can take ownership if its starting CLI disappears.
    return (
      existing.host === LOCAL_HOSTNAME &&
      !processIsAlive(existing.pid) &&
      isPastLockLease(existing.acquiredAt)
    );
  }
  return observation.protected && isPastLockLease(observation.stats.mtimeMs);
};

const releaseLock = (lockPath: string, token: string) => async () => {
  let observation: FileObservation | undefined;
  try {
    observation = await readObservation(lockPath, 16 * 1024);
  } catch (cause) {
    if (isNotFound(cause)) {
      return;
    }
    throw cause;
  }
  if (observation === undefined) {
    return;
  }
  const existing = parseJson(observation.contents);
  if (isValidLock(existing) && existing.token === token) {
    await removeIfSame(lockPath, observation);
  }
};

const createLock = async (
  paths: DaemonPaths,
  deadline = Date.now() + LIFECYCLE_LOCK_WAIT_MS,
  lockPath = paths.lockPath
) => {
  const token = randomBytes(32).toString("base64url");
  const descriptor = {
    version: DAEMON_LOCK_VERSION,
    pid: process.pid,
    host: LOCAL_HOSTNAME,
    token,
    acquiredAt: Date.now(),
  } satisfies LockDescriptor;

  while (true) {
    let file: FileHandle | undefined;
    try {
      file = await open(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        PRIVATE_FILE_MODE
      );
      await file.writeFile(JSON.stringify(descriptor), "utf8");
      await file.sync();
      await file.close();
      return {
        token,
        // The token identity makes this cleanup safe after adoption: once the
        // daemon transfers the lock, this token no longer matches and the
        // starter cannot unlink the daemon's lock.
        release: releaseLock(lockPath, token),
      } satisfies LifecycleLock;
    } catch (cause) {
      const createdLock = file !== undefined;
      await file?.close().catch(() => undefined);
      if (!isAlreadyExists(cause)) {
        if (createdLock) {
          await unlink(lockPath).catch(() => undefined);
        }
        throw new DaemonStartupBusyError({
          path: lockPath,
          message: `Could not acquire the daemon lifecycle lock: ${describe(cause)}`,
        });
      }

      const inspected = await inspectLock(lockPath);
      if (inspected === undefined) {
        continue;
      }
      const observation = inspected.observation;
      const existing = observation === undefined ? undefined : parseJson(observation.contents);
      // A well-formed lock is recovered through owner liveness plus its
      // conservative lease. Never use age to evict a live PID; doing so can
      // let two lifecycle operations run concurrently when the first one is
      // paused in startup or shutdown.
      if (observation !== undefined && isRecoverableLock(inspected, existing)) {
        await removeIfSame(lockPath, observation);
        continue;
      }
      if (Date.now() < deadline) {
        await wait(STARTUP_POLL_MS);
        continue;
      }
      throw new DaemonStartupBusyError({
        path: lockPath,
        message:
          "Another Planview lifecycle operation is in progress, or its lock is malformed and has not exceeded the conservative lease.",
      });
    }
  }
};

const adoptLock = async (paths: DaemonPaths, token: string) => {
  const inspected = await inspectLock(paths.lockPath);
  const observation = inspected?.observation;
  const existing = observation === undefined ? undefined : parseJson(observation.contents);
  if (!inspected?.protected || observation === undefined || !isValidLock(existing)) {
    throw new DaemonStartupBusyError({
      path: paths.lockPath,
      message: "The daemon could not adopt its lifecycle lock from the starting CLI.",
    });
  }
  if (existing.token !== token) {
    throw new DaemonStartupBusyError({
      path: paths.lockPath,
      message: "The daemon lifecycle lock belongs to another operation.",
    });
  }

  // Transfer ownership instead of sharing the starter's token. This makes a
  // late starter cleanup harmless even if it races the daemon's adoption.
  const adoptedToken = randomBytes(32).toString("base64url");
  const adopted = {
    ...existing,
    pid: process.pid,
    token: adoptedToken,
    acquiredAt: Date.now(),
  } satisfies LockDescriptor;
  let file: FileHandle | undefined;
  try {
    file = await open(
      paths.lockPath,
      constants.O_RDWR | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW)
    );
    const currentStats = await file.stat();
    if (!sameFile(observation.stats, currentStats)) {
      throw new Error("The daemon lifecycle lock was replaced during adoption.");
    }
    const current = parseJson(await file.readFile({ encoding: "utf8" }));
    if (!isValidLock(current) || current.token !== token) {
      throw new Error("The daemon lifecycle lock changed during adoption.");
    }
    await file.truncate(0);
    await file.write(JSON.stringify(adopted), 0, "utf8");
    await file.sync();
  } catch (cause) {
    throw new DaemonStartupBusyError({
      path: paths.lockPath,
      message: `The daemon could not adopt its lifecycle lock: ${describe(cause)}`,
    });
  } finally {
    await file?.close().catch(() => undefined);
  }

  // The daemon owns the transferred token until it has published a usable
  // descriptor. It then releases the lock itself, so the starter can disappear
  // at any point after adoption without stranding lifecycle operations.
  return {
    token: adoptedToken,
    release: releaseLock(paths.lockPath, adoptedToken),
  } satisfies LifecycleLock;
};

const writeProtectedDescriptor = async (paths: DaemonPaths, descriptor: RuntimeDescriptor) => {
  const temporaryPath = join(
    dirname(paths.descriptorPath),
    `.${DAEMON_DESCRIPTOR_NAME}.${randomBytes(16).toString("hex")}.tmp`
  );
  await writeFile(temporaryPath, JSON.stringify(descriptor), {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
  try {
    await chmod(temporaryPath, PRIVATE_FILE_MODE);
    await rename(temporaryPath, paths.descriptorPath);
  } catch (cause) {
    await unlink(temporaryPath).catch(() => undefined);
    throw new DaemonDescriptorError({
      path: paths.descriptorPath,
      message: `Could not publish the protected daemon descriptor: ${describe(cause)}`,
    });
  }
};

const removeDescriptorFor = async (paths: DaemonPaths, descriptor: RuntimeDescriptor) => {
  const observation = await readObservation(paths.descriptorPath, 16 * 1024);
  if (observation === undefined) {
    return;
  }
  const current = parseJson(observation.contents);
  if (
    isValidDescriptor(current) &&
    current.pid === descriptor.pid &&
    current.secret === descriptor.secret
  ) {
    await removeIfSame(paths.descriptorPath, observation);
  }
};

const listen = (server: import("node:http").Server, host: string, port: number) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    const onError = (cause: Error) => {
      server.off("listening", onListening);
      rejectPromise(cause);
    };
    const onListening = () => {
      server.off("error", onError);
      resolvePromise();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

const forceCloseServer = (server: import("node:http").Server, connections: ReadonlySet<Socket>) => {
  server.closeIdleConnections();
  server.closeAllConnections();
  for (const connection of connections) {
    connection.destroy();
  }
};

const closeServer = (server: import("node:http").Server, connections: ReadonlySet<Socket>) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    const finish = (cause?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (cause === undefined) {
        resolvePromise();
      } else {
        rejectPromise(cause);
      }
    };

    if (!server.listening) {
      forceCloseServer(server, connections);
      finish();
      return;
    }
    // close() does not make an unref'd keep-alive socket observable to its
    // callback on every supported Node release. Close idle sockets before
    // waiting, while active requests still get the normal graceful path.
    server.closeIdleConnections();
    server.close((cause) => {
      if (cause === undefined || ("code" in cause && cause.code === "ERR_SERVER_NOT_RUNNING")) {
        finish();
      } else {
        finish(cause);
      }
    });
  });

const response = (
  res: import("node:http").ServerResponse,
  status: number,
  body: string,
  type = "application/json"
) => {
  res.statusCode = status;
  res.setHeader("Content-Type", `${type}; charset=utf-8`);
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
};

const htmlError = (_status: number, title: string, message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>${message}</p></body></html>`;

const statusPayload = (descriptor: RuntimeDescriptor) =>
  ({
    state: "running",
    pid: descriptor.pid,
    host: descriptor.host,
    port: descriptor.port,
    startedAt: descriptor.startedAt,
  }) satisfies DaemonStatusPayload;

const secretFrom = (request: import("node:http").IncomingMessage) => {
  const header = request.headers[DAEMON_SECRET_HEADER];
  if (typeof header === "string") {
    return header;
  }
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
};

const sameSecret = (left: string | undefined, right: string) => {
  if (left === undefined) {
    return false;
  }
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
};

const readJsonBody = async (request: import("node:http").IncomingMessage, signal?: AbortSignal) => {
  signal?.throwIfAborted();
  const chunks: Buffer[] = [];
  let size = 0;
  const onAbort = () => {
    request.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of request) {
      signal?.throwIfAborted();
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_PUBLISH_REQUEST_BYTES) {
        throw new Error("The publish request body is too large.");
      }
      chunks.push(bytes);
    }
    signal?.throwIfAborted();
    return parseJson(Buffer.concat(chunks).toString("utf8"));
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
};

type OperationGate = {
  <Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
    requestSignal?: AbortSignal
  ): Promise<Value>;
  readonly close: (cause?: unknown) => void;
  readonly abortActive: (cause?: unknown) => void;
  readonly isIdle: () => boolean;
  readonly waitForIdle: () => Promise<void>;
};

type OperationEntry = {
  readonly controller: AbortController;
  readonly start: () => void;
  readonly reject: (cause: unknown) => void;
  readonly requestSignal?: AbortSignal;
  readonly onRequestAbort?: () => void;
};

// Publication and cleanup still share a short mutation gate. It preserves the
// publication file-to-metadata commit boundary, while reads use independent
// leases and never wait behind an arbitrary response transfer. Unlike a bare
// promise tail, the gate can reject queued work and abort the operation that is
// currently at the mutation boundary during daemon shutdown.
const createOperationGate = () => {
  const queued: OperationEntry[] = [];
  const idleWaiters = new Set<() => void>();
  let running: OperationEntry | undefined;
  let closed = false;

  const notifyIdle = () => {
    if (running !== undefined || queued.length > 0) {
      return;
    }
    for (const resolvePromise of idleWaiters) {
      resolvePromise();
    }
    idleWaiters.clear();
  };

  const pump = () => {
    if (closed || running !== undefined) {
      return;
    }
    const next = queued.shift();
    if (next === undefined) {
      notifyIdle();
      return;
    }
    running = next;
    next.start();
  };

  const run = <Value>(
    operation: (signal: AbortSignal) => Promise<Value>,
    requestSignal?: AbortSignal
  ) => {
    if (closed) {
      return Promise.reject(new Error("The daemon is shutting down."));
    }
    if (requestSignal?.aborted) {
      return Promise.reject(requestSignal.reason);
    }

    return new Promise<Value>((resolvePromise, rejectPromise) => {
      const controller = new AbortController();
      let entry: OperationEntry;
      const onRequestAbort = () => {
        controller.abort(requestSignal?.reason ?? new Error("The operation request was aborted."));
        const index = queued.indexOf(entry);
        if (index >= 0) {
          queued.splice(index, 1);
          rejectPromise(controller.signal.reason);
          notifyIdle();
        }
      };
      const start = () => {
        void Promise.resolve()
          .then(() => operation(controller.signal))
          .then(resolvePromise, rejectPromise)
          .finally(() => {
            if (requestSignal !== undefined) {
              requestSignal.removeEventListener("abort", onRequestAbort);
            }
            if (running === entry) {
              running = undefined;
            }
            pump();
            notifyIdle();
          });
      };
      entry = {
        controller,
        start,
        reject: rejectPromise,
        ...(requestSignal === undefined ? {} : { requestSignal, onRequestAbort }),
      };
      queued.push(entry);
      requestSignal?.addEventListener("abort", onRequestAbort, { once: true });
      pump();
    });
  };

  const close = (cause: unknown = new Error("The daemon is shutting down.")) => {
    if (closed) {
      return;
    }
    closed = true;
    for (const entry of queued.splice(0)) {
      entry.controller.abort(cause);
      if (entry.requestSignal !== undefined && entry.onRequestAbort !== undefined) {
        entry.requestSignal.removeEventListener("abort", entry.onRequestAbort);
      }
      entry.reject(cause);
    }
    notifyIdle();
  };

  const abortActive = (cause: unknown = new Error("The daemon shutdown deadline elapsed.")) => {
    running?.controller.abort(cause);
  };

  const isIdle = () => running === undefined && queued.length === 0;
  const waitForIdle = () =>
    isIdle()
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => idleWaiters.add(resolvePromise));

  return Object.assign(run, { close, abortActive, isIdle, waitForIdle }) satisfies OperationGate;
};

class DocumentReadAdmissionError extends Error {
  readonly code: "capacity" | "closed" | "timeout";

  constructor(code: "capacity" | "closed" | "timeout") {
    super(
      code === "capacity"
        ? "The daemon has reached its bounded document-read capacity."
        : code === "timeout"
          ? "The daemon document-read queue deadline elapsed."
          : "The daemon is shutting down."
    );
    this.name = "DocumentReadAdmissionError";
    this.code = code;
  }
}

const createDocumentReadAdmission = () => {
  const active = new Set<{
    readonly controller: AbortController;
    released: boolean;
  }>();
  const queued: Array<{
    readonly resolve: (permit: DocumentReadPermit) => void;
    readonly reject: (cause: unknown) => void;
    readonly signal?: AbortSignal;
    readonly onAbort?: () => void;
    readonly timer: NodeJS.Timeout;
  }> = [];
  let closing = false;

  const removeQueued = (entry: (typeof queued)[number]) => {
    const index = queued.indexOf(entry);
    if (index < 0) {
      return false;
    }
    queued.splice(index, 1);
    clearTimeout(entry.timer);
    if (entry.signal !== undefined && entry.onAbort !== undefined) {
      entry.signal.removeEventListener("abort", entry.onAbort);
    }
    return true;
  };

  const makePermit = () => {
    const state = { controller: new AbortController(), released: false };
    active.add(state);
    return {
      signal: state.controller.signal,
      release: () => {
        if (state.released) {
          return;
        }
        state.released = true;
        active.delete(state);
        drain();
      },
    } satisfies DocumentReadPermit;
  };

  const drain = () => {
    while (!closing && active.size < DAEMON_MAX_ACTIVE_DOCUMENT_READS) {
      const next = queued.shift();
      if (next === undefined) {
        return;
      }
      clearTimeout(next.timer);
      if (next.signal !== undefined && next.onAbort !== undefined) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      next.resolve(makePermit());
    }
  };

  const acquire = (signal?: AbortSignal) => {
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    if (closing) {
      return Promise.reject(new DocumentReadAdmissionError("closed"));
    }
    if (active.size < DAEMON_MAX_ACTIVE_DOCUMENT_READS) {
      return Promise.resolve(makePermit());
    }
    if (queued.length >= DAEMON_MAX_QUEUED_DOCUMENT_READS) {
      return Promise.reject(new DocumentReadAdmissionError("capacity"));
    }
    return new Promise<DocumentReadPermit>((resolvePromise, rejectPromise) => {
      let entry: (typeof queued)[number];
      const onAbort = () => {
        if (removeQueued(entry)) {
          rejectPromise(signal?.reason);
        }
      };
      const timer = setTimeout(() => {
        if (removeQueued(entry)) {
          rejectPromise(new DocumentReadAdmissionError("timeout"));
        }
      }, DAEMON_DOCUMENT_READ_QUEUE_TIMEOUT_MS);
      entry = {
        resolve: resolvePromise,
        reject: rejectPromise,
        ...(signal === undefined ? {} : { signal, onAbort }),
        timer,
      };
      queued.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  const close = () => {
    if (closing) {
      return;
    }
    closing = true;
    for (const queuedRead of queued.splice(0)) {
      clearTimeout(queuedRead.timer);
      if (queuedRead.signal !== undefined && queuedRead.onAbort !== undefined) {
        queuedRead.signal.removeEventListener("abort", queuedRead.onAbort);
      }
      queuedRead.reject(new DocumentReadAdmissionError("closed"));
    }
    for (const state of active) {
      state.controller.abort(new Error("The daemon is shutting down."));
    }
  };

  return { acquire, close };
};

type DocumentReadPermit = Readonly<{
  readonly signal: AbortSignal;
  readonly release: () => void;
}>;

const PRIVATE_MANAGEMENT_PATHS = new Set([
  DAEMON_READY_PATH,
  DAEMON_STARTUP_ACK_PATH,
  DAEMON_STATUS_PATH,
  DAEMON_SHUTDOWN_PATH,
  DAEMON_PUBLISH_PATH,
  DAEMON_CLEAN_PATH,
  "/internal/clean",
  "/internal/ready",
  "/internal/status",
  "/internal/shutdown",
]);

const documentIdFromPath = (url: string) => {
  if (!url.startsWith("/") || url.length < 2) {
    return undefined;
  }
  const candidate = url.slice(1);
  return candidate.includes("/") ? undefined : candidate;
};

const handlePublishedDocument = async (
  documentId: string,
  res: import("node:http").ServerResponse,
  publicationCoordinator: DocumentPublicationCoordinator,
  metadataStore: MetadataStore,
  permit: DocumentReadPermit,
  requestSignal?: AbortSignal
) => {
  const id = (() => {
    try {
      return validateDocumentId(documentId);
    } catch {
      return undefined;
    }
  })();
  if (id === undefined) {
    response(
      res,
      404,
      htmlError(404, "Not found", "That Planview document does not exist."),
      "text/html"
    );
    permit.release();
    return;
  }

  const document = await publicationCoordinator.readPublishedDocumentLease(id).catch((cause) => {
    if (
      cause instanceof DocumentPublicationNotFoundError ||
      cause instanceof DocumentPublicationReadError
    ) {
      return undefined;
    }
    throw cause;
  });
  if (document === undefined) {
    response(
      res,
      404,
      htmlError(404, "Not found", "That Planview document does not exist."),
      "text/html"
    );
    permit.release();
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  const controller = new AbortController();
  const resettableSignal = AbortSignal.any(
    requestSignal === undefined
      ? [controller.signal, permit.signal]
      : [controller.signal, permit.signal, requestSignal]
  );
  const abort = (cause: unknown) => {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (!controller.signal.aborted) {
      controller.abort(error);
    }
    document.stream.destroy(error);
    if (!res.destroyed && !res.writableFinished) {
      res.destroy(error);
    }
  };
  let idleTimer: NodeJS.Timeout | undefined;
  let absoluteTimer: NodeJS.Timeout | undefined;
  const resetIdleTimer = () => {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(
      () => abort(new Error("The document download became idle.")),
      DAEMON_DOCUMENT_READ_IDLE_TIMEOUT_MS
    );
    idleTimer.unref();
  };
  const onResponseClose = () => {
    if (!res.writableFinished) {
      abort(new Error("The document download client disconnected."));
    }
  };
  const onPermitAbort = () =>
    abort(permit.signal.reason ?? new Error("The daemon is shutting down."));
  let completed = false;
  document.stream.on("data", resetIdleTimer);
  res.on("drain", resetIdleTimer);
  res.once("close", onResponseClose);
  permit.signal.addEventListener("abort", onPermitAbort, { once: true });
  resetIdleTimer();
  absoluteTimer = setTimeout(
    () => abort(new Error("The document download deadline elapsed.")),
    DAEMON_DOCUMENT_READ_MAX_DURATION_MS
  );
  absoluteTimer.unref();
  try {
    await pipeline(document.stream, res, { signal: resettableSignal });
    completed = true;
    // The access timestamp is deliberately recorded only once the immutable file
    // stream and the HTTP response have completed successfully.
    try {
      metadataStore.recordDocumentAccess(id);
    } catch {
      // The document was already delivered. There is no safe second response once
      // the body has finished, so leave the daemon available for the next request.
    }
  } finally {
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
    }
    if (absoluteTimer !== undefined) {
      clearTimeout(absoluteTimer);
    }
    document.stream.off("data", resetIdleTimer);
    res.off("drain", resetIdleTimer);
    res.off("close", onResponseClose);
    permit.signal.removeEventListener("abort", onPermitAbort);
    document.release();
    permit.release();
    if (!completed) {
      abort(new Error("The document download did not complete."));
    }
  }
};

const handleRequest = async (
  request: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  descriptor: RuntimeDescriptor,
  requestShutdown: () => void,
  publicationCoordinator: DocumentPublicationCoordinator,
  metadataStore: MetadataStore,
  runCleanup: (signal?: AbortSignal) => Promise<DocumentCleanupResult>,
  isReady: () => boolean,
  documentReadAdmission: ReturnType<typeof createDocumentReadAdmission>,
  operationGate: OperationGate,
  acknowledgeStartup: () => void,
  requestSignal?: AbortSignal,
  isAccepting = () => true
) => {
  let url: string;
  try {
    url = request.url === undefined ? "/" : new URL(request.url, `http://${DAEMON_HOST}`).pathname;
  } catch {
    response(
      res,
      404,
      htmlError(404, "Not found", "That Planview document does not exist."),
      "text/html"
    );
    return;
  }

  if (!isAccepting() && url !== DAEMON_SHUTDOWN_PATH && url !== "/internal/shutdown") {
    response(res, 503, JSON.stringify({ error: "shutting_down" }));
    return;
  }

  // Management routes are an exact set. Do this check before the public
  // single-segment route so a valid document id such as __planview_________x
  // remains public without weakening authentication on management endpoints.
  const privatePath = PRIVATE_MANAGEMENT_PATHS.has(url);
  if (!privatePath) {
    const documentId = documentIdFromPath(url);
    if (documentId !== undefined) {
      if (request.method === "GET") {
        if (!isReady()) {
          response(res, 503, JSON.stringify({ error: "not_ready" }));
          return;
        }
        let permit: DocumentReadPermit | undefined;
        try {
          const requestAbort = new AbortController();
          const abortRequest = () => requestAbort.abort(new Error("The client disconnected."));
          request.once("aborted", abortRequest);
          permit = await documentReadAdmission.acquire(requestAbort.signal);
          request.off("aborted", abortRequest);
          await handlePublishedDocument(
            documentId,
            res,
            publicationCoordinator,
            metadataStore,
            permit,
            requestSignal
          );
        } catch (cause) {
          permit?.release();
          if (!res.destroyed && !res.headersSent) {
            const status =
              cause instanceof DocumentReadAdmissionError
                ? 503
                : request.aborted || request.destroyed
                  ? 499
                  : undefined;
            if (status !== undefined) {
              response(
                res,
                status,
                JSON.stringify({
                  error: status === 503 ? "read_capacity" : "read_aborted",
                  message: describe(cause),
                })
              );
            } else {
              throw cause;
            }
          }
        }
      } else {
        response(
          res,
          405,
          htmlError(405, "Method not allowed", "Planview documents are retrieved with GET."),
          "text/html"
        );
      }
      return;
    }
  }

  if (url === "/" && request.method === "GET") {
    response(
      res,
      isReady() ? 200 : 503,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Planview daemon</title></head><body><h1>Planview daemon running</h1><p>Listening on ${descriptor.host}:${descriptor.port}.</p></body></html>`,
      "text/html"
    );
    return;
  }

  if (!privatePath) {
    response(
      res,
      404,
      htmlError(404, "Not found", "That Planview document does not exist."),
      "text/html"
    );
    return;
  }
  if (!sameSecret(secretFrom(request), descriptor.secret)) {
    response(res, 401, JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if ((url === DAEMON_READY_PATH || url === "/internal/ready") && request.method === "GET") {
    if (!isReady()) {
      response(res, 503, JSON.stringify({ ready: false, ...statusPayload(descriptor) }));
      return;
    }
    response(res, 200, JSON.stringify({ ready: true, ...statusPayload(descriptor) }));
    return;
  }
  if (url === DAEMON_STARTUP_ACK_PATH && request.method === "POST") {
    response(res, 202, JSON.stringify({ acknowledged: true }));
    acknowledgeStartup();
    return;
  }
  if ((url === DAEMON_STATUS_PATH || url === "/internal/status") && request.method === "GET") {
    response(res, 200, JSON.stringify(statusPayload(descriptor)));
    return;
  }
  if (!isReady() && !(url === DAEMON_SHUTDOWN_PATH || url === "/internal/shutdown")) {
    response(res, 503, JSON.stringify({ error: "not_ready" }));
    return;
  }
  if ((url === DAEMON_SHUTDOWN_PATH || url === "/internal/shutdown") && request.method === "POST") {
    response(res, 202, JSON.stringify({ shuttingDown: true }));
    requestShutdown();
    return;
  }
  if ((url === DAEMON_CLEAN_PATH || url === "/internal/clean") && request.method === "POST") {
    try {
      const result = await runCleanup(requestSignal);
      response(
        res,
        200,
        JSON.stringify({
          ...result,
          failures: result.failures.map(({ cause, ...failure }) => ({
            ...failure,
            cause: describe(cause),
          })),
        })
      );
    } catch (cause) {
      if (requestSignal?.aborted || res.destroyed) {
        return;
      }
      response(res, 500, JSON.stringify({ error: "cleanup_failed", message: describe(cause) }));
    }
    return;
  }
  if (url === DAEMON_PUBLISH_PATH && request.method === "POST") {
    let payload: unknown;
    try {
      payload = await readJsonBody(request, requestSignal);
    } catch (cause) {
      if (requestSignal?.aborted || res.destroyed) {
        return;
      }
      response(res, 400, JSON.stringify({ error: "invalid_request", message: describe(cause) }));
      return;
    }
    const sourcePath = isRecord(payload) ? recordValue(payload, "sourcePath") : undefined;
    if (typeof sourcePath !== "string" || sourcePath.length === 0) {
      response(
        res,
        400,
        JSON.stringify({ error: "invalid_request", message: "sourcePath is required." })
      );
      return;
    }
    try {
      if (isTestProcess()) {
        const pauseMilliseconds = Number(process.env[TEST_PUBLISH_PAUSE_ENV]);
        const pauseOnce = process.env[TEST_PUBLISH_PAUSE_ONCE_ENV] === "1";
        if (
          Number.isFinite(pauseMilliseconds) &&
          pauseMilliseconds > 0 &&
          (!pauseOnce || !testPublishPauseConsumed)
        ) {
          testPublishPauseConsumed = true;
          await wait(
            pauseMilliseconds,
            process.env[TEST_UNCOOPERATIVE_PUBLISH_ENV] === "1" ? undefined : requestSignal
          );
        }
      }
      const published = await operationGate(
        (signal) => publicationCoordinator.publish(sourcePath, signal),
        requestSignal
      );
      // Keep this response synchronous: 201 means the publication is committed
      // and can be retrieved immediately by its immutable id.
      response(res, 201, JSON.stringify({ id: published.id }));
    } catch (cause) {
      if (requestSignal?.aborted || res.destroyed) {
        return;
      }
      response(res, 422, JSON.stringify({ error: "publish_failed", message: describe(cause) }));
    }
    return;
  }
  response(res, 405, JSON.stringify({ error: "method_not_allowed" }));
};

const createDaemonServer = (
  descriptor: RuntimeDescriptor,
  requestShutdown: () => void,
  publicationCoordinator: DocumentPublicationCoordinator,
  metadataStore: MetadataStore,
  runCleanup: (signal?: AbortSignal) => Promise<DocumentCleanupResult>,
  isReady: () => boolean,
  documentReadAdmission: ReturnType<typeof createDocumentReadAdmission>,
  operationGate: OperationGate,
  acknowledgeStartup: () => void
) => {
  const server = import("node:http").then(({ createServer }) => {
    const connections = new Set<Socket>();
    const requests = new Set<{
      readonly controller: AbortController;
      readonly request: import("node:http").IncomingMessage;
    }>();
    const requestIdleWaiters = new Set<() => void>();
    let accepting = true;
    const notifyRequestsIdle = () => {
      if (requests.size !== 0) {
        return;
      }
      for (const resolvePromise of requestIdleWaiters) {
        resolvePromise();
      }
      requestIdleWaiters.clear();
    };
    const stopAccepting = () => {
      if (!accepting) {
        return;
      }
      accepting = false;
      // Do this as the first shutdown action. Otherwise an idle keep-alive
      // socket can make server.close() wait until the same instant as the
      // process SIGKILL fallback.
      httpServer.closeIdleConnections();
    };
    const abortRequests = () => {
      for (const { controller } of requests) {
        controller.abort(new Error("The daemon shutdown deadline elapsed."));
      }
    };
    const waitForRequests = () =>
      requests.size === 0
        ? Promise.resolve()
        : new Promise<void>((resolvePromise) => requestIdleWaiters.add(resolvePromise));
    const httpServer = createServer((request, res) => {
      const controller = new AbortController();
      const activeRequest = { controller, request };
      requests.add(activeRequest);
      const abortIfIncomplete = (cause: Error) => {
        if (!res.writableFinished) {
          controller.abort(cause);
        }
      };
      const onRequestAborted = () => abortIfIncomplete(new Error("The client disconnected."));
      const onResponseClosed = () => {
        // IncomingMessage#aborted does not fire when a peer stops consuming a
        // response after its request body has already been read.
        abortIfIncomplete(new Error("The client closed the response."));
      };
      request.once("aborted", onRequestAborted);
      res.once("close", onResponseClosed);
      void handleRequest(
        request,
        res,
        descriptor,
        requestShutdown,
        publicationCoordinator,
        metadataStore,
        runCleanup,
        isReady,
        documentReadAdmission,
        operationGate,
        acknowledgeStartup,
        controller.signal,
        () => accepting
      )
        .catch((cause) => {
          if (!res.headersSent) {
            response(res, 500, JSON.stringify({ error: "internal_error" }));
          } else {
            res.destroy(cause instanceof Error ? cause : undefined);
          }
        })
        .finally(() => {
          request.off("aborted", onRequestAborted);
          res.off("close", onResponseClosed);
          requests.delete(activeRequest);
          notifyRequestsIdle();
        });
    });
    httpServer.on("connection", (connection) => {
      connections.add(connection);
      connection.once("close", () => connections.delete(connection));
    });
    return {
      server: httpServer,
      connections,
      stopAccepting,
      forceClose: () => forceCloseServer(httpServer, connections),
      abortRequests,
      waitForRequests,
    };
  });
  return server;
};

const openDaemon = async (config: DaemonConfig) => {
  const paths = resolveDaemonPaths(config);
  await ensurePrivateDirectory(paths.appDataDir);
  await ensurePrivateDirectory(paths.runtimeDir);
  await ensureRuntimeContained(paths);

  const delegatedToken = process.env[LIFECYCLE_TOKEN_ENV];
  let acknowledgeStartup = () => {};
  const startupAcknowledgement =
    delegatedToken === undefined
      ? Promise.resolve()
      : new Promise<void>((resolvePromise) => {
          acknowledgeStartup = resolvePromise;
        });
  const lock =
    delegatedToken === undefined ? await createLock(paths) : await adoptLock(paths, delegatedToken);
  if (delegatedToken !== undefined && isTestProcess()) {
    const pauseMilliseconds = Number(process.env[TEST_ADOPTION_PAUSE_ENV]);
    if (Number.isFinite(pauseMilliseconds) && pauseMilliseconds > 0) {
      await wait(pauseMilliseconds);
    }
  }
  let server: import("node:http").Server | undefined;
  let connections: Set<Socket> | undefined;
  let descriptor: RuntimeDescriptor | undefined;
  let documentFileStore: DocumentFileStore | undefined;
  let metadataStore: MetadataStore | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  let cleanupDrain: Promise<void> | undefined;
  let startupReady = false;
  let shutdownInitiated = false;
  let shutdownRequested = false;
  let resolveShutdown: (() => void) | undefined;
  let stopAccepting = () => {};
  let forceCloseConnections = () => {};
  let abortRequests = () => {};
  let waitForRequests = () => Promise.resolve();
  let shutdownDeadline: number | undefined;
  let shutdownAbortTimer: NodeJS.Timeout | undefined;
  let shutdownForceCloseTimer: NodeJS.Timeout | undefined;
  let shutdownForceTimer: NodeJS.Timeout | undefined;
  let shutdownCompleted = false;
  const documentReadAdmission = createDocumentReadAdmission();
  const operationGate = createOperationGate();
  const terminateUncooperativeProcess = () => {
    try {
      // The descriptor remains in place until this process is dead. A later
      // lifecycle operation can then prove the PID is gone before replacement.
      process.kill(process.pid, "SIGKILL");
    } catch {
      process.exit(1);
    }
  };
  const beginShutdown = () => {
    if (shutdownInitiated) {
      return;
    }
    shutdownInitiated = true;
    shutdownDeadline = Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS;
    documentReadAdmission.close();
    operationGate.close();
    stopAccepting();
    shutdownAbortTimer = setTimeout(() => {
      operationGate.abortActive();
      abortRequests();
    }, DAEMON_SHUTDOWN_OPERATION_GRACE_MS);
    shutdownAbortTimer.unref();
    const forceCloseDelay = Math.max(
      0,
      DAEMON_SHUTDOWN_TIMEOUT_MS - SHUTDOWN_FORCE_CLOSE_MARGIN_MS
    );
    shutdownForceCloseTimer = setTimeout(() => {
      forceCloseConnections();
    }, forceCloseDelay);
    shutdownForceCloseTimer.unref();
    shutdownForceTimer = setTimeout(() => {
      if (!shutdownCompleted) {
        // The forced socket close has already run. If work or storage still
        // has not reached its safe boundary, retain the hard process bound.
        terminateUncooperativeProcess();
      }
    }, DAEMON_SHUTDOWN_TIMEOUT_MS);
    shutdownForceTimer.unref();
    resolveShutdown?.();
  };
  const requestShutdown = () => {
    shutdownRequested = true;
    beginShutdown();
  };
  try {
    const openedMetadataStore = Effect.runSync(
      openStorage(join(config.appDataDir, "metadata.sqlite"))
    );
    metadataStore = openedMetadataStore;
    const openedDocumentFileStore = Effect.runSync(
      openDocumentFileStore({
        documentsDir: join(config.appDataDir, "documents"),
        stagingDir: join(config.appDataDir, "staging"),
      })
    );
    documentFileStore = openedDocumentFileStore;
    const publicationCoordinator = createDocumentPublicationCoordinator({
      documentFileStore: openedDocumentFileStore,
      metadataStore: openedMetadataStore,
    });
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore: openedDocumentFileStore,
      metadataStore: openedMetadataStore,
      ...(isTestProcess()
        ? {
            beforeDocumentCleanup: async (_id: string, signal?: AbortSignal) => {
              const pauseMilliseconds = Number(process.env[TEST_CLEANUP_PAUSE_ENV]);
              if (Number.isFinite(pauseMilliseconds) && pauseMilliseconds > 0) {
                await wait(pauseMilliseconds, signal);
              }
            },
          }
        : {}),
    });
    const runCleanupSlice = (requestSignal?: AbortSignal) => {
      // Manual and scheduled cleanup share the same mutation gate. Reads do
      // not enter it, so a client that stops consuming a response cannot delay
      // cleanup.
      return operationGate((signal) => cleanup.clean(signal), requestSignal);
    };
    const scheduleCleanupDrain = () => {
      if (cleanupDrain !== undefined || shutdownInitiated) {
        return;
      }
      const drain = (async () => {
        while (!shutdownInitiated) {
          const result = await runCleanupSlice();
          if (!result.resumable) {
            return;
          }
          // Every slice is bounded; yielding here prevents automatic cleanup
          // from monopolizing the daemon's event loop while a large store is
          // being drained.
          await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
        }
      })();
      cleanupDrain = drain;
      void drain.then(
        () => {
          if (cleanupDrain === drain) {
            cleanupDrain = undefined;
          }
        },
        () => {
          if (cleanupDrain === drain) {
            cleanupDrain = undefined;
          }
        }
      );
    };
    const runCleanup = (requestSignal?: AbortSignal) => {
      const operation = runCleanupSlice(requestSignal);
      return operation.then((result) => {
        if (result.resumable && !shutdownInitiated) {
          scheduleCleanupDrain();
        }
        return result;
      });
    };
    descriptor = {
      version: DAEMON_DESCRIPTOR_VERSION,
      pid: process.pid,
      host: config.host,
      port: config.port,
      secret: randomBytes(32).toString("base64url"),
      startedAt: Date.now(),
    };
    const daemonServer = await createDaemonServer(
      descriptor,
      requestShutdown,
      publicationCoordinator,
      metadataStore,
      runCleanup,
      () => startupReady,
      documentReadAdmission,
      operationGate,
      acknowledgeStartup
    );
    server = daemonServer.server;
    connections = daemonServer.connections;
    stopAccepting = daemonServer.stopAccepting;
    forceCloseConnections = daemonServer.forceClose;
    abortRequests = daemonServer.abortRequests;
    waitForRequests = daemonServer.waitForRequests;
    await listen(server, config.host, config.port);
    if (server === undefined || descriptor === undefined || connections === undefined) {
      throw new Error("The daemon listener was not initialized.");
    }
    // Publish the endpoint while startup cleanup is in progress, but keep
    // readiness false. Callers can distinguish a live, bounded reconciliation
    // from a dead child instead of waiting on an invisible process.
    await writeProtectedDescriptor(paths, descriptor);
    await runCleanup();
    if (shutdownInitiated) {
      throw new Error("The daemon shutdown began during startup.");
    }
    startupReady = true;
    await requestReady(descriptor);
    cleanupTimer = setInterval(() => {
      void runCleanup().catch(() => undefined);
    }, DAEMON_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref();
    // A detached starter must observe readiness before another lifecycle
    // operation can stop this child. If the starter crashes, the bounded
    // fallback releases the lock without stranding future operations.
    await Promise.race([startupAcknowledgement, wait(DAEMON_STARTUP_GRACE_MS)]);
    await lock.release();
    const runningServer = server;
    const runningConnections = connections;
    const runningDescriptor = descriptor;
    return {
      server: runningServer,
      descriptor: runningDescriptor,
      paths,
      close: (() => {
        let closePromise: Promise<void> | undefined;
        return () => {
          if (closePromise !== undefined) {
            return closePromise;
          }
          closePromise = (async () => {
            beginShutdown();
            resolveShutdown = undefined;
            if (cleanupTimer !== undefined) {
              clearInterval(cleanupTimer);
              cleanupTimer = undefined;
            }

            const deadline = shutdownDeadline ?? Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS;
            const settleBeforeDeadline = async (promise: Promise<unknown>) => {
              const remaining = deadline - Date.now();
              if (remaining <= 0) {
                return false;
              }
              let timer: NodeJS.Timeout | undefined;
              try {
                return await Promise.race([
                  promise.then(
                    () => true,
                    () => false
                  ),
                  new Promise<boolean>((resolvePromise) => {
                    timer = setTimeout(() => resolvePromise(false), remaining);
                  }),
                ]);
              } finally {
                if (timer !== undefined) {
                  clearTimeout(timer);
                }
              }
            };

            const serverClose = closeServer(runningServer, runningConnections);
            const workSettled = await settleBeforeDeadline(
              Promise.all([operationGate.waitForIdle(), waitForRequests()])
            );
            if (!workSettled) {
              operationGate.abortActive();
              abortRequests();
              // A native or third-party operation that ignores cancellation
              // may still mutate storage. Killing the process is the only safe
              // boundary; removing the descriptor would permit a replacement
              // daemon to run concurrently with that mutation.
              terminateUncooperativeProcess();
              return new Promise<void>(() => {});
            }
            if (shutdownAbortTimer !== undefined) {
              clearTimeout(shutdownAbortTimer);
              shutdownAbortTimer = undefined;
            }

            const storageSettled = await settleBeforeDeadline(
              (async () => {
                try {
                  await documentFileStore?.close();
                } finally {
                  metadataStore?.close();
                }
              })()
            );
            if (!storageSettled) {
              terminateUncooperativeProcess();
              return new Promise<void>(() => {});
            }

            const serverSettled = await settleBeforeDeadline(serverClose);
            if (!serverSettled) {
              terminateUncooperativeProcess();
              return new Promise<void>(() => {});
            }
            // Descriptor removal is the final lifecycle action. At this point
            // no request, mutation, storage close, or listener can still run.
            await removeDescriptorFor(paths, runningDescriptor);
            shutdownCompleted = true;
            if (shutdownForceCloseTimer !== undefined) {
              clearTimeout(shutdownForceCloseTimer);
              shutdownForceCloseTimer = undefined;
            }
            if (shutdownForceTimer !== undefined) {
              clearTimeout(shutdownForceTimer);
              shutdownForceTimer = undefined;
            }
          })();
          return closePromise;
        };
      })(),
      waitForShutdown: () => {
        if (shutdownRequested) {
          return Promise.resolve();
        }
        return new Promise<void>((resolvePromise) => {
          const onSignal = () => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            resolvePromise();
          };
          process.once("SIGINT", onSignal);
          process.once("SIGTERM", onSignal);
          resolveShutdown = () => {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
            resolvePromise();
          };
        });
      },
    };
  } catch (cause) {
    if (shutdownAbortTimer !== undefined) {
      clearTimeout(shutdownAbortTimer);
      shutdownAbortTimer = undefined;
    }
    if (shutdownForceCloseTimer !== undefined) {
      clearTimeout(shutdownForceCloseTimer);
      shutdownForceCloseTimer = undefined;
    }
    if (shutdownForceTimer !== undefined) {
      clearTimeout(shutdownForceTimer);
      shutdownForceTimer = undefined;
    }
    documentReadAdmission.close();
    await lock.release().catch(() => undefined);
    if (server !== undefined && connections !== undefined) {
      await closeServer(server, connections).catch(() => undefined);
    }
    await documentFileStore?.close().catch(() => undefined);
    metadataStore?.close();
    if (descriptor !== undefined) {
      await removeDescriptorFor(paths, descriptor).catch(() => undefined);
    }
    if (isAddressInUse(cause)) {
      throw new DaemonPortInUseError({
        host: config.host,
        port: config.port,
        message: `Port ${config.port} on ${config.host} is already in use; Planview will not stop an unknown owner.`,
      });
    }
    throw cause;
  }
};

const isAddressInUse = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EADDRINUSE";

const request = (
  descriptor: RuntimeDescriptor,
  method: string,
  path: string,
  body?: string,
  timeoutMs = REQUEST_TIMEOUT_MS
) =>
  new Promise<DaemonResponse>((resolvePromise, rejectPromise) => {
    const requestObject = httpRequest(
      {
        host: descriptor.host,
        port: descriptor.port,
        method,
        path,
        headers: {
          [DAEMON_SECRET_HEADER]: descriptor.secret,
          Authorization: `Bearer ${descriptor.secret}`,
          ...(body === undefined
            ? {}
            : {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
              }),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolvePromise({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    requestObject.on("timeout", () =>
      requestObject.destroy(new Error("The daemon request timed out."))
    );
    requestObject.on("error", rejectPromise);
    if (body === undefined) {
      requestObject.end();
    } else {
      requestObject.end(body);
    }
  });

const assertDescriptorEndpoint = (
  config: DaemonConfig,
  descriptor: Readonly<{ readonly host: string; readonly port: number }>,
  path: string
) => {
  if (descriptor.host === config.host && descriptor.port === config.port) {
    return;
  }
  throw new DaemonDescriptorEndpointMismatchError({
    path,
    descriptorHost: descriptor.host,
    descriptorPort: descriptor.port,
    configHost: config.host,
    configPort: config.port,
    message: `The daemon descriptor points to ${descriptor.host}:${descriptor.port}, but the configured daemon endpoint is ${config.host}:${config.port}.`,
  });
};

const parseResponse = <Value>(answer: DaemonResponse, path: string, statusCode: number) => {
  if (answer.statusCode !== statusCode) {
    throw new DaemonRequestError({
      path,
      cause: answer.body,
      message: `The daemon returned HTTP ${answer.statusCode} for ${path}.`,
    });
  }
  const parsed = parseJson(answer.body);
  if (!isRecord(parsed)) {
    throw new DaemonRequestError({
      path,
      cause: answer.body,
      message: `The daemon returned invalid JSON for ${path}.`,
    });
  }
  return parsed as Value;
};

const streamDocument = (
  descriptor: RuntimeDescriptor,
  documentId: import("@planview/core").DocumentId,
  onChunk: (chunk: Uint8Array) => void | Promise<void>
) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    let responseObject: import("node:http").IncomingMessage | undefined;
    let settled = false;

    const abort = (cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      responseObject?.destroy(error);
      requestObject.destroy(error);
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolvePromise();
    };
    const fail = (cause: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      abort(cause);
      rejectPromise(cause);
    };

    const requestObject = httpRequest(
      {
        host: descriptor.host,
        port: descriptor.port,
        method: "GET",
        path: `/${documentId}`,
        headers: {
          [DAEMON_SECRET_HEADER]: descriptor.secret,
          Authorization: `Bearer ${descriptor.secret}`,
        },
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        responseObject = res;
        // Once headers arrive, stdout backpressure is the request's normal
        // flow-control mechanism. Do not turn a slow consumer into a timeout.
        requestObject.setTimeout(0);
        const consume = async () => {
          if (res.statusCode !== 200) {
            const chunks: Buffer[] = [];
            for await (const chunk of res) {
              chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
            }
            const body = Buffer.concat(chunks).toString("utf8");
            throw new DaemonRequestError({
              path: `/${documentId}`,
              cause: body,
              message:
                res.statusCode === 404
                  ? `The Planview document ${documentId} was not found.`
                  : `The daemon returned HTTP ${res.statusCode ?? 0} for /${documentId}.`,
            });
          }

          for await (const chunk of res) {
            await onChunk(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
        };

        void consume().then(succeed, fail);
      }
    );
    requestObject.on("timeout", () => fail(new Error("The daemon request timed out.")));
    requestObject.on("error", fail);
    requestObject.end();
  });

const requestStatus = async (descriptor: RuntimeDescriptor) => {
  const answer = await request(descriptor, "GET", DAEMON_STATUS_PATH);
  return parseResponse<DaemonStatusPayload>(answer, DAEMON_STATUS_PATH, 200);
};

const requestReady = async (descriptor: RuntimeDescriptor) => {
  const answer = await request(descriptor, "GET", DAEMON_READY_PATH);
  return parseResponse<Record<string, unknown>>(answer, DAEMON_READY_PATH, 200);
};

const acknowledgeDaemonStartup = async (descriptor: RuntimeDescriptor) => {
  const answer = await request(descriptor, "POST", DAEMON_STARTUP_ACK_PATH);
  return parseResponse<Record<string, unknown>>(answer, DAEMON_STARTUP_ACK_PATH, 202);
};

const requestClean = async (descriptor: RuntimeDescriptor, timeoutMs: number) => {
  const answer = await request(descriptor, "POST", DAEMON_CLEAN_PATH, undefined, timeoutMs);
  return parseResponse<Record<string, unknown>>(answer, DAEMON_CLEAN_PATH, 200);
};

const portIsOpen = (host: string, port: number) =>
  new Promise<boolean>((resolvePromise) => {
    let settled = false;
    const socket: Socket = createConnection({ host, port });
    const finish = (open: boolean) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolvePromise(open);
      }
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(false));
  });

const wait = (milliseconds: number, signal?: AbortSignal) => {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export const inspectDaemon = async (config: DaemonConfig): Promise<DaemonState> => {
  const paths = resolveDaemonPaths(config);
  const descriptor = await readDaemonDescriptor(paths);
  if (descriptor === undefined) {
    return { state: "stopped" };
  }
  assertDescriptorEndpoint(config, descriptor, paths.descriptorPath);
  try {
    const status = await requestStatus(descriptor);
    assertDescriptorEndpoint(config, status, DAEMON_STATUS_PATH);
    return { state: "running", descriptor, status };
  } catch (cause) {
    if (cause instanceof DaemonDescriptorEndpointMismatchError) {
      throw cause;
    }
    if (!processIsAlive(descriptor.pid)) {
      await removeDeadDescriptor(paths, descriptor);
      return { state: "stopped" };
    }
    throw new DaemonRequestError({
      path: DAEMON_STATUS_PATH,
      cause,
      message: `The daemon descriptor belongs to a live process but its private status endpoint is unavailable: ${describe(cause)}`,
    });
  }
};

const cleanupTimeoutFor = (count: number, size: number) => {
  const documentBudget = count * CLEANUP_DOCUMENT_BUDGET_MS;
  const byteBudget = Math.ceil(size / CLEANUP_BYTE_BUDGET_BYTES_PER_MS);
  return Math.min(
    DAEMON_CLEANUP_TIMEOUT_MAX_MS,
    Math.max(
      DAEMON_CLEANUP_TIMEOUT_MIN_MS,
      DAEMON_CLEANUP_TIMEOUT_MIN_MS + documentBudget + byteBudget
    )
  );
};

const estimateCleanupTimeout = (config: DaemonConfig) => {
  try {
    const metadataStore = Effect.runSync(openStorage(join(config.appDataDir, "metadata.sqlite")));
    try {
      const aggregate = metadataStore.getDocumentAggregate();
      return cleanupTimeoutFor(aggregate.count, aggregate.size);
    } finally {
      metadataStore.close();
    }
  } catch {
    // Startup can still create/migrate the database. If its size cannot be
    // sampled, use the bounded maximum rather than making readiness timing
    // depend on an unobserved, and therefore ambiguous, estimate.
    return DAEMON_CLEANUP_TIMEOUT_MAX_MS;
  }
};

const waitForReady = async (
  config: DaemonConfig,
  timeoutMs = STARTUP_TIMEOUT_MS,
  child?: import("node:child_process").ChildProcess
) => {
  const paths = resolveDaemonPaths(config);
  const deadline = Date.now() + timeoutMs;
  let readinessObserved = false;
  let startupFailure: DaemonRequestError | undefined;
  let rejectChildFailure: ((error: DaemonRequestError) => void) | undefined;
  const childFailure =
    child === undefined
      ? undefined
      : new Promise<never>((_, reject) => {
          rejectChildFailure = reject;
        });
  const failForChild = (cause: unknown) => {
    if (readinessObserved || startupFailure !== undefined) {
      return;
    }
    startupFailure = new DaemonRequestError({
      path: DAEMON_READY_PATH,
      cause,
      message: `The detached Planview daemon failed before readiness: ${describe(cause)}`,
    });
    rejectChildFailure?.(startupFailure);
  };
  const onChildError = (cause: Error) => failForChild(cause);
  const onChildExit = (code: number | null, signal: NodeJS.Signals | null) =>
    failForChild(
      new Error(
        signal === null
          ? `The detached daemon exited with code ${code ?? 0}.`
          : `The detached daemon exited after signal ${signal}.`
      )
    );
  const raceWithChild = <Value>(operation: Promise<Value>) => {
    if (childFailure === undefined) {
      return operation;
    }
    return Promise.race([operation, childFailure]);
  };

  child?.once("error", onChildError);
  child?.once("exit", onChildExit);
  if (child !== undefined && (child.exitCode !== null || child.signalCode !== null)) {
    onChildExit(child.exitCode, child.signalCode);
  }
  try {
    while (Date.now() < deadline) {
      const descriptor = await raceWithChild(readDaemonDescriptor(paths));
      if (descriptor !== undefined) {
        assertDescriptorEndpoint(config, descriptor, paths.descriptorPath);
        try {
          const ready = await raceWithChild(requestReady(descriptor));
          const readyHost = isRecord(ready) ? recordValue(ready, "host") : undefined;
          const readyPort = isRecord(ready) ? recordValue(ready, "port") : undefined;
          if (typeof readyHost !== "string" || typeof readyPort !== "number") {
            throw new DaemonRequestError({
              path: DAEMON_READY_PATH,
              cause: ready,
              message: `The daemon returned an invalid endpoint for ${DAEMON_READY_PATH}.`,
            });
          }
          assertDescriptorEndpoint(config, { host: readyHost, port: readyPort }, DAEMON_READY_PATH);
          await raceWithChild(acknowledgeDaemonStartup(descriptor));
          readinessObserved = true;
          return { state: "running", descriptor, reused: false };
        } catch (cause) {
          if (startupFailure !== undefined) {
            throw startupFailure;
          }
          if (cause instanceof DaemonDescriptorEndpointMismatchError) {
            throw cause;
          }
          // The listener can be accepting connections a few milliseconds before
          // the readiness response is observable. Keep polling within the bound.
        }
      }
      // A descriptor may disappear after this child becomes ready when a
      // concurrent lifecycle operation immediately performs its own restart.
      // Continue to the bounded deadline and observe the next descriptor rather
      // than misclassifying that normal handoff as this startup's failure. Do not
      // probe the port here: an in-flight startup owns it and a second probe must
      // never classify it as an unknown process.
      await raceWithChild(wait(STARTUP_POLL_MS));
    }
  } finally {
    child?.off("error", onChildError);
    child?.off("exit", onChildExit);
  }
  throw new DaemonRequestError({
    path: DAEMON_READY_PATH,
    cause: new Error("startup timeout"),
    message: "The Planview daemon did not become ready before the startup timeout.",
  });
};

export type StartDaemonOptions = Readonly<{
  readonly daemonScriptPath: string;
}>;

const prepareLifecyclePaths = async (config: DaemonConfig) => {
  const paths = resolveDaemonPaths(config);
  await ensurePrivateDirectory(paths.appDataDir);
  await ensurePrivateDirectory(paths.runtimeDir);
  await ensureRuntimeContained(paths);
  return paths;
};

const startWithLock = async (
  config: DaemonConfig,
  options: StartDaemonOptions,
  paths: DaemonPaths,
  lock: LifecycleLock,
  startupTimeoutMs: number
) => {
  const current = await inspectDaemon(config);
  if (current.state === "running") {
    return { ...current, reused: true };
  }

  const startupDescriptor = await readDescriptorForStartup(paths);
  if (startupDescriptor !== undefined) {
    assertDescriptorEndpoint(config, startupDescriptor, paths.descriptorPath);
  }
  if (await portIsOpen(config.host, config.port)) {
    throw new DaemonPortInUseError({
      host: config.host,
      port: config.port,
      message: `Port ${config.port} on ${config.host} is occupied by an unknown process; Planview will not stop it.`,
    });
  }
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [options.daemonScriptPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: {
      ...process.env,
      PLANVIEW_APP_DATA_DIR: config.appDataDir,
      PLANVIEW_RUNTIME_DIR: config.runtimeDir,
      [LIFECYCLE_TOKEN_ENV]: lock.token,
      ...(isTestProcess() || config.port !== DAEMON_PORT
        ? { NODE_ENV: "test", [TEST_PORT_ENV]: String(config.port) }
        : {}),
    },
  });
  child.unref();
  return waitForReady(config, startupTimeoutMs, child);
};

export const startDetachedDaemon = async (config: DaemonConfig, options: StartDaemonOptions) => {
  const paths = await prepareLifecyclePaths(config);
  const startupTimeoutMs = estimateCleanupTimeout(config);
  const lock = await createLock(paths);
  try {
    return await startWithLock(config, options, paths, lock, startupTimeoutMs);
  } finally {
    await lock.release();
  }
};

export type PublishDaemonOptions = Readonly<{
  readonly daemonScriptPath: string;
  readonly sourcePath: string;
  /** The validated source size lets the client budget for the bounded copy. */
  readonly sourceSizeBytes?: number;
}>;

const cleanupResultFromPayload = (payload: Record<string, unknown>) => {
  const numericFields = [
    "now",
    "cutoff",
    "removedDocuments",
    "removedDocumentFiles",
    "removedMetadataRows",
    "removedStagedFiles",
    "removedReadReferences",
    "removedFinalizationLocks",
    "reclaimedBytes",
    "retainedEntries",
    "processedItems",
  ] as const;
  if (
    numericFields.some(
      (field) =>
        typeof recordValue(payload, field) !== "number" ||
        !Number.isSafeInteger(recordValue(payload, field)) ||
        (recordValue(payload, field) as number) < 0
    )
  ) {
    throw new DaemonRequestError({
      path: DAEMON_CLEAN_PATH,
      cause: payload,
      message: `The daemon returned an invalid cleanup result for ${DAEMON_CLEAN_PATH}.`,
    });
  }
  const rawFailures = recordValue(payload, "failures");
  if (!Array.isArray(rawFailures)) {
    throw new DaemonRequestError({
      path: DAEMON_CLEAN_PATH,
      cause: payload,
      message: `The daemon returned an invalid cleanup result for ${DAEMON_CLEAN_PATH}.`,
    });
  }
  const failures = rawFailures.map((failure) => {
    if (!isRecord(failure) || typeof recordValue(failure, "phase") !== "string") {
      throw new DaemonRequestError({
        path: DAEMON_CLEAN_PATH,
        cause: payload,
        message: `The daemon returned an invalid cleanup result for ${DAEMON_CLEAN_PATH}.`,
      });
    }
    const phase = recordValue(failure, "phase");
    if (phase !== "staging" && phase !== "metadata" && phase !== "document-file") {
      throw new DaemonRequestError({
        path: DAEMON_CLEAN_PATH,
        cause: payload,
        message: `The daemon returned an invalid cleanup result for ${DAEMON_CLEAN_PATH}.`,
      });
    }
    const id = recordValue(failure, "id");
    const message = recordValue(failure, "message");
    if ((id !== undefined && typeof id !== "string") || typeof message !== "string") {
      throw new DaemonRequestError({
        path: DAEMON_CLEAN_PATH,
        cause: payload,
        message: `The daemon returned an invalid cleanup result for ${DAEMON_CLEAN_PATH}.`,
      });
    }
    const normalizedPhase: DocumentCleanupFailure["phase"] =
      phase === "staging" ? "staging" : phase === "metadata" ? "metadata" : "document-file";
    return {
      phase: normalizedPhase,
      ...(id === undefined ? {} : { id }),
      cause: recordValue(failure, "cause"),
      message,
    };
  });
  const numberValue = (field: (typeof numericFields)[number]) =>
    recordValue(payload, field) as number;
  return {
    now: numberValue("now"),
    cutoff: numberValue("cutoff"),
    removedDocuments: numberValue("removedDocuments"),
    removedDocumentFiles: numberValue("removedDocumentFiles"),
    removedMetadataRows: numberValue("removedMetadataRows"),
    removedStagedFiles: numberValue("removedStagedFiles"),
    removedReadReferences: numberValue("removedReadReferences"),
    removedFinalizationLocks: numberValue("removedFinalizationLocks"),
    reclaimedBytes: numberValue("reclaimedBytes"),
    retainedEntries: numberValue("retainedEntries"),
    processedItems: numberValue("processedItems"),
    resumable: (() => {
      const value = recordValue(payload, "resumable");
      if (typeof value !== "boolean") {
        throw new DaemonRequestError({
          path: DAEMON_CLEAN_PATH,
          cause: payload,
          message: `The daemon returned an invalid cleanup result for ${DAEMON_CLEAN_PATH}.`,
        });
      }
      return value;
    })(),
    failures,
  } satisfies DocumentCleanupResult;
};

export const publishDocument = async (config: DaemonConfig, options: PublishDaemonOptions) => {
  const running = await startDetachedDaemon(config, { daemonScriptPath: options.daemonScriptPath });
  const answer = await request(
    running.descriptor,
    "POST",
    DAEMON_PUBLISH_PATH,
    JSON.stringify({ sourcePath: options.sourcePath }),
    publishRequestTimeout(options.sourceSizeBytes)
  );
  const payload = parseResponse<Record<string, unknown>>(answer, DAEMON_PUBLISH_PATH, 201);
  try {
    const id = validateDocumentId(recordValue(payload, "id"));
    return { id, descriptor: running.descriptor, reused: running.reused };
  } catch (cause) {
    throw new DaemonRequestError({
      path: DAEMON_PUBLISH_PATH,
      cause,
      message: `The daemon returned an invalid published document id for ${DAEMON_PUBLISH_PATH}.`,
    });
  }
};

export const cleanDaemon = async (config: DaemonConfig, options: StartDaemonOptions) => {
  const running = await startDetachedDaemon(config, options);
  const payload = await requestClean(running.descriptor, estimateCleanupTimeout(config));
  return {
    descriptor: running.descriptor,
    reused: running.reused,
    result: cleanupResultFromPayload(payload),
  } satisfies CleanedDaemonDocuments;
};

export const retrieveDocument = async (config: DaemonConfig, options: RetrieveDaemonOptions) => {
  const documentId = validateDocumentId(options.documentId);
  const running = await startDetachedDaemon(config, { daemonScriptPath: options.daemonScriptPath });
  await streamDocument(running.descriptor, documentId, options.onChunk);
  return { descriptor: running.descriptor, reused: running.reused };
};

const stopWithLock = async (config: DaemonConfig) => {
  const current = await inspectDaemon(config);
  if (current.state === "stopped") {
    return current;
  }
  const paths = resolveDaemonPaths(config);
  const answer = await request(current.descriptor, "POST", DAEMON_SHUTDOWN_PATH);
  parseResponse<Record<string, unknown>>(answer, DAEMON_SHUTDOWN_PATH, 202);
  const deadline =
    Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS + REQUEST_TIMEOUT_MS + SHUTDOWN_POLL_GRACE_MS;
  while (Date.now() < deadline) {
    const descriptor = await readDaemonDescriptor(paths);
    if (descriptor !== undefined) {
      assertDescriptorEndpoint(config, descriptor, paths.descriptorPath);
    }
    if (descriptor === undefined || !processIsAlive(descriptor.pid)) {
      if (descriptor !== undefined) {
        await removeDeadDescriptor(paths, descriptor);
      }
      return { state: "stopped" } as const;
    }
    await wait(STARTUP_POLL_MS);
  }
  throw new DaemonRequestError({
    path: DAEMON_SHUTDOWN_PATH,
    cause: new Error("shutdown timeout"),
    message: "The Planview daemon did not shut down before the shutdown timeout.",
  });
};

export const stopDaemon = async (config: DaemonConfig) => {
  const paths = await prepareLifecyclePaths(config);
  const lock = await createLock(paths);
  try {
    return await stopWithLock(config);
  } finally {
    await lock.release();
  }
};

export const restartDaemon = async (config: DaemonConfig, options: StartDaemonOptions) => {
  const paths = await prepareLifecyclePaths(config);
  const lock = await createLock(paths);
  try {
    await stopWithLock(config);
    return await startWithLock(config, options, paths, lock, estimateCleanupTimeout(config));
  } finally {
    await lock.release();
  }
};

const daemonLifecycle = (config: DaemonConfig) =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => openDaemon(config),
      catch: (cause) => cause,
    }),
    (resource) =>
      Effect.tryPromise({
        try: () => resource.waitForShutdown(),
        catch: (cause) => cause,
      }),
    (resource) =>
      Effect.tryPromise({
        try: () => resource.close(),
        catch: (cause) => cause,
      })
  );

export const runDaemon = (config: DaemonConfig = resolveDaemonConfig()) => daemonLifecycle(config);

export const runDaemonProcess = async (config: DaemonConfig = resolveDaemonConfig()) => {
  await Effect.runPromise(runDaemon(config));
};
