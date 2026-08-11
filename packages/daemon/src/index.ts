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
import { resolveAppDataPaths, V1_PORT } from "@planview/core";
import { Data, Effect } from "effect";

export const DAEMON_HOST = "127.0.0.1" as const;
/** The v1 daemon port is fixed for the public CLI. */
export const DAEMON_PORT = V1_PORT;
export const DAEMON_STARTUP_LEASE_MS = 30_000;
export const DAEMON_STARTUP_GRACE_MS = 5_000;
export const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;
export const DAEMON_DESCRIPTOR_VERSION = 1;
export const DAEMON_DESCRIPTOR_NAME = "daemon.json";
export const DAEMON_LOCK_NAME = "lifecycle.lock";
export const DAEMON_SECRET_HEADER = "x-planview-secret";
export const DAEMON_READY_PATH = "/__planview/ready";
export const DAEMON_STATUS_PATH = "/__planview/status";
export const DAEMON_SHUTDOWN_PATH = "/__planview/shutdown";
const DAEMON_LOCK_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const REQUEST_TIMEOUT_MS = 1_000;
const STARTUP_TIMEOUT_MS = 10_000;
const STARTUP_POLL_MS = 50;
const LOCAL_HOSTNAME = hostname();
const TEST_PORT_ENV = "PLANVIEW_TEST_DAEMON_PORT";
const TEST_ADOPTION_PAUSE_ENV = "PLANVIEW_TEST_DAEMON_ADOPTION_PAUSE_MS";
const LIFECYCLE_TOKEN_ENV = "PLANVIEW_DAEMON_LIFECYCLE_TOKEN";
const isTestProcess = () => {
  const { NODE_ENV } = process.env;
  return NODE_ENV === "test";
};

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

type DaemonResponse = Readonly<{
  readonly statusCode: number;
  readonly body: string;
}>;

type LifecycleLock = Readonly<{
  readonly token: string;
  readonly release: () => Promise<void>;
  readonly handoff: () => void;
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
  const observation = await readObservation(lockPath, 16 * 1024);
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
  deadline = Date.now() + STARTUP_TIMEOUT_MS,
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
      let handedOff = false;
      return {
        token,
        release: async () => {
          // Once a detached daemon has been spawned, the daemon owns the
          // pathname. The starter must not race its adoption by unlinking the
          // lock after a crash or a startup timeout.
          if (!handedOff) {
            await releaseLock(lockPath, token)();
          }
        },
        handoff: () => {
          handedOff = true;
        },
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
    handoff: () => undefined,
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

const closeServer = (server: import("node:http").Server, connections: ReadonlySet<Socket>) =>
  new Promise<void>((resolvePromise, rejectPromise) => {
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const finish = (cause?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (deadlineTimer !== undefined) {
        clearTimeout(deadlineTimer);
      }
      if (cause === undefined) {
        resolvePromise();
      } else {
        rejectPromise(cause);
      }
    };
    const forceClose = () => {
      server.closeIdleConnections();
      server.closeAllConnections();
      for (const connection of connections) {
        connection.destroy();
      }
      finish();
    };

    if (!server.listening) {
      forceClose();
      return;
    }
    deadlineTimer = setTimeout(forceClose, DAEMON_SHUTDOWN_TIMEOUT_MS);
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

const handleRequest = async (
  request: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  descriptor: RuntimeDescriptor,
  requestShutdown: () => void
) => {
  const url =
    request.url === undefined ? "/" : new URL(request.url, `http://${DAEMON_HOST}`).pathname;
  if (url === "/" && request.method === "GET") {
    response(
      res,
      200,
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Planview daemon</title></head><body><h1>Planview daemon running</h1><p>Listening on ${descriptor.host}:${descriptor.port}.</p></body></html>`,
      "text/html"
    );
    return;
  }

  const privatePath =
    url === DAEMON_READY_PATH ||
    url === DAEMON_STATUS_PATH ||
    url === DAEMON_SHUTDOWN_PATH ||
    url === "/internal/ready" ||
    url === "/internal/status" ||
    url === "/internal/shutdown";
  if (!privatePath) {
    response(res, 404, JSON.stringify({ error: "not_found" }));
    return;
  }
  if (!sameSecret(secretFrom(request), descriptor.secret)) {
    response(res, 401, JSON.stringify({ error: "unauthorized" }));
    return;
  }

  if ((url === DAEMON_READY_PATH || url === "/internal/ready") && request.method === "GET") {
    response(res, 200, JSON.stringify({ ready: true, ...statusPayload(descriptor) }));
    return;
  }
  if ((url === DAEMON_STATUS_PATH || url === "/internal/status") && request.method === "GET") {
    response(res, 200, JSON.stringify(statusPayload(descriptor)));
    return;
  }
  if ((url === DAEMON_SHUTDOWN_PATH || url === "/internal/shutdown") && request.method === "POST") {
    response(res, 202, JSON.stringify({ shuttingDown: true }));
    requestShutdown();
    return;
  }
  response(res, 405, JSON.stringify({ error: "method_not_allowed" }));
};

const createDaemonServer = (descriptor: RuntimeDescriptor, requestShutdown: () => void) => {
  const server = import("node:http").then(({ createServer }) => {
    const connections = new Set<Socket>();
    const httpServer = createServer((request, res) => {
      void handleRequest(request, res, descriptor, requestShutdown).catch((cause) => {
        if (!res.headersSent) {
          response(res, 500, JSON.stringify({ error: "internal_error" }));
        } else {
          res.destroy(cause instanceof Error ? cause : undefined);
        }
      });
    });
    httpServer.on("connection", (connection) => {
      connections.add(connection);
      connection.once("close", () => connections.delete(connection));
    });
    return { server: httpServer, connections };
  });
  return server;
};

const openDaemon = async (config: DaemonConfig) => {
  const paths = resolveDaemonPaths(config);
  await ensurePrivateDirectory(paths.appDataDir);
  await ensurePrivateDirectory(paths.runtimeDir);
  await ensureRuntimeContained(paths);

  const delegatedToken = process.env[LIFECYCLE_TOKEN_ENV];
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
  let closing = false;
  let shutdownRequested = false;
  let resolveShutdown: (() => void) | undefined;
  const requestShutdown = () => {
    shutdownRequested = true;
    resolveShutdown?.();
  };
  try {
    descriptor = {
      version: DAEMON_DESCRIPTOR_VERSION,
      pid: process.pid,
      host: config.host,
      port: config.port,
      secret: randomBytes(32).toString("base64url"),
      startedAt: Date.now(),
    };
    const daemonServer = await createDaemonServer(descriptor, requestShutdown);
    server = daemonServer.server;
    connections = daemonServer.connections;
    await listen(server, config.host, config.port);
    if (server === undefined || descriptor === undefined || connections === undefined) {
      throw new Error("The daemon listener was not initialized.");
    }
    // Complete the authenticated readiness handshake before publishing the
    // descriptor. Other lifecycle operations use the same lock and cannot
    // inspect the port or descriptor until this daemon is fully usable.
    await requestReady(descriptor);
    await writeProtectedDescriptor(paths, descriptor);
    await lock.release();
    const runningServer = server;
    const runningConnections = connections;
    const runningDescriptor = descriptor;
    return {
      server: runningServer,
      descriptor: runningDescriptor,
      paths,
      close: async () => {
        if (closing) {
          return;
        }
        closing = true;
        resolveShutdown = undefined;
        try {
          await closeServer(runningServer, runningConnections);
        } finally {
          await removeDescriptorFor(paths, runningDescriptor);
        }
      },
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
    await lock.release().catch(() => undefined);
    if (server !== undefined && connections !== undefined) {
      await closeServer(server, connections).catch(() => undefined);
    }
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

const request = (descriptor: RuntimeDescriptor, method: string, path: string) =>
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
        },
        timeout: REQUEST_TIMEOUT_MS,
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
    requestObject.end();
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

const requestStatus = async (descriptor: RuntimeDescriptor) => {
  const answer = await request(descriptor, "GET", DAEMON_STATUS_PATH);
  return parseResponse<DaemonStatusPayload>(answer, DAEMON_STATUS_PATH, 200);
};

const requestReady = async (descriptor: RuntimeDescriptor) => {
  const answer = await request(descriptor, "GET", DAEMON_READY_PATH);
  return parseResponse<Record<string, unknown>>(answer, DAEMON_READY_PATH, 200);
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

const wait = (milliseconds: number) =>
  new Promise<void>((resolvePromise) => setTimeout(resolvePromise, milliseconds));

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

const waitForReady = async (config: DaemonConfig) => {
  const paths = resolveDaemonPaths(config);
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const descriptor = await readDaemonDescriptor(paths);
    if (descriptor !== undefined) {
      assertDescriptorEndpoint(config, descriptor, paths.descriptorPath);
      try {
        const ready = await requestReady(descriptor);
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
        return { state: "running", descriptor, reused: false };
      } catch (cause) {
        if (cause instanceof DaemonDescriptorEndpointMismatchError) {
          throw cause;
        }
        // The listener can be accepting connections a few milliseconds before
        // the readiness response is observable. Keep polling within the bound.
      }
    }
    // The caller owns the lifecycle lock for this entire wait. Do not probe
    // the port here: an in-flight startup owns that port and a second probe
    // must never classify it as an unknown process.
    await wait(STARTUP_POLL_MS);
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
  lock: LifecycleLock
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
  // The child now owns the lock. Mark that handoff before waiting for
  // readiness; the parent must never unlink the lock while adoption is in
  // progress or after the daemon has recorded its ownership.
  lock.handoff();
  child.unref();
  return waitForReady(config);
};

export const startDetachedDaemon = async (config: DaemonConfig, options: StartDaemonOptions) => {
  const paths = await prepareLifecyclePaths(config);
  const lock = await createLock(paths, Date.now() + STARTUP_TIMEOUT_MS);
  try {
    return await startWithLock(config, options, paths, lock);
  } finally {
    await lock.release();
  }
};

const stopWithLock = async (config: DaemonConfig) => {
  const current = await inspectDaemon(config);
  if (current.state === "stopped") {
    return current;
  }
  const paths = resolveDaemonPaths(config);
  const answer = await request(current.descriptor, "POST", DAEMON_SHUTDOWN_PATH);
  parseResponse<Record<string, unknown>>(answer, DAEMON_SHUTDOWN_PATH, 202);
  const deadline = Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS + REQUEST_TIMEOUT_MS;
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
  const lock = await createLock(paths, Date.now() + STARTUP_TIMEOUT_MS);
  try {
    return await stopWithLock(config);
  } finally {
    await lock.release();
  }
};

export const restartDaemon = async (config: DaemonConfig, options: StartDaemonOptions) => {
  const paths = await prepareLifecyclePaths(config);
  const lock = await createLock(paths, Date.now() + STARTUP_TIMEOUT_MS);
  try {
    await stopWithLock(config);
    return await startWithLock(config, options, paths, lock);
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
