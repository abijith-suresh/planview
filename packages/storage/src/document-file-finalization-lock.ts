import { randomBytes as cryptoRandomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DocumentFileNotRegularError } from "./document-file-types.js";
import { sameFileIdentity, type FileIdentity } from "./document-file-identity.js";
import { isProcessAlive, LOCAL_HOSTNAME } from "./document-file-owner-process.js";

const FINALIZATION_LOCK_METADATA_NAME = "owner.json";
const FINALIZATION_LOCK_METADATA_BYTES = 4 * 1024;
const FINALIZATION_LOCK_LEASE_MS = 30_000;
const FINALIZATION_LOCK_RECOVERY_GRACE_MS = 5_000;
export const DOCUMENT_FILE_RECOVERY_GRACE_MILLISECONDS =
  FINALIZATION_LOCK_LEASE_MS + FINALIZATION_LOCK_RECOVERY_GRACE_MS;
const FINALIZATION_LOCK_OWNER_TOKEN_BYTES = 16;
const FINALIZATION_LOCK_RECOVERY_CLAIM_NAME = ".recovery-claim";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const NO_FOLLOW = process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0);
const NON_BLOCKING = process.platform === "win32" ? 0 : (constants.O_NONBLOCK ?? 0);
class FinalizationLockBusyError extends Error {}
export { FinalizationLockBusyError };

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

const errorCode = (error: unknown) => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
};

const isNotFound = (error: unknown) => errorCode(error) === "ENOENT";

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const regularFileError = (path: string) =>
  new DocumentFileNotRegularError({
    path,
    message: `The document file must be a regular file and must not be a symbolic link: ${path}.`,
  });

const openWithoutFollowingLinks = async (path: string, flags: number, displayPath = path) => {
  const beforeOpen = await lstat(path);
  if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) {
    throw regularFileError(displayPath);
  }

  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
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
    return file;
  } catch (cause) {
    await file?.close().catch(() => undefined);
    throw cause;
  }
};

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
    metadataFile = await openWithoutFollowingLinks(metadataPath, constants.O_RDONLY, metadataPath);
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

export type FinalizationLockLease = {
  readonly identity: FileIdentity;
  readonly metadataIdentity?: FileIdentity;
  readonly recoveryClaimName?: string;
  readonly recoveryClaimIdentity?: FileIdentity;
};

const readFinalizationRecoveryClaim = async (claimPath: string) => {
  let claimFile: Awaited<ReturnType<typeof open>> | undefined;
  try {
    claimFile = await openWithoutFollowingLinks(claimPath, constants.O_RDONLY, claimPath);
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

export const removeFinalizationLockDirectory = async (
  lockPath: string,
  lease?: FinalizationLockLease
) => {
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

export const acquireFinalizationLock = async (
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
