import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, mkdtemp, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_NAMES = ["planview", "create-html"] as const;
type SkillName = (typeof SKILL_NAMES)[number];
const bundledSkillsDirectory = fileURLToPath(new URL("../skills/", import.meta.url));

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const SKILLS_LOCK_NAME = ".planview-skills.lock";
const TRANSACTION_PREFIX = ".planview-skills-txn-";
const JOURNAL_NAME = "journal.json";
const PREVIOUS_DIRECTORY_NAME = ".previous";
const LOCK_VERSION = 1;
const TRANSACTION_VERSION = 1;
const LOCK_WAIT_MS = 60_000;
// A dead PID is not enough evidence by itself: a new process may have reused
// the PID. The short grace period also gives a just-created malformed lock a
// chance to finish its metadata write before recovery considers it stale.
const LOCK_RECOVERY_GRACE_MS = 1_000;
const TEST_CRASH_ENV = "PLANVIEW_TEST_SKILLS_CRASH_AT";
const TEST_PAUSE_ENV = "PLANVIEW_TEST_SKILLS_PAUSE_MS";
const TEST_PAUSE_AT_ENV = "PLANVIEW_TEST_SKILLS_PAUSE_AT";
const NO_FOLLOW = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
const DIRECTORY = process.platform === "win32" ? 0 : constants.O_DIRECTORY;
const LOCAL_HOSTNAME = hostname();

const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause
    ? Reflect.get(cause, "code")
    : undefined;

const isCode = (cause: unknown, code: string) => errorCode(cause) === code;

const describe = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

const missingPath = async (path: string) => {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isCode(cause, "ENOENT")) {
      return undefined;
    }
    throw cause;
  }
};

const isOwnedByCurrentUser = (stats: Stats) =>
  process.platform === "win32" ||
  process.getuid?.() === undefined ||
  stats.uid === process.getuid?.();

const isWritableByOtherUsers = (stats: Stats) =>
  process.platform !== "win32" && (stats.mode & 0o022) !== 0;

const sameIdentity = (left: Stats, right: Stats) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs;

const identityFromStats = (stats: Stats) => ({
  dev: stats.dev,
  ino: stats.ino,
  size: stats.size,
  mtimeMs: stats.mtimeMs,
  mode: stats.mode & 0o7777,
});

type FileIdentity = ReturnType<typeof identityFromStats>;

const sameObjectIdentity = (stats: Stats, identity: FileIdentity) =>
  stats.dev === identity.dev &&
  stats.ino === identity.ino &&
  (stats.dev !== 0 ||
    stats.ino !== 0 ||
    (stats.size === identity.size && stats.mtimeMs === identity.mtimeMs));

const sameRecordedIdentity = (stats: Stats, identity: FileIdentity) =>
  sameObjectIdentity(stats, identity) &&
  stats.size === identity.size &&
  stats.mtimeMs === identity.mtimeMs &&
  (stats.mode & 0o7777) === identity.mode;

const assertOwnedAndStableDirectory = async (path: string, label: string, privateMode = false) => {
  const stats = await missingPath(path);
  if (stats === undefined) {
    return false;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use ${label} because it is a symbolic link: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to use ${label} because it is not a directory: ${path}`);
  }
  if (!isOwnedByCurrentUser(stats)) {
    throw new Error(
      `Refusing to use ${label} because it is not owned by the current user: ${path}`
    );
  }
  if (isWritableByOtherUsers(stats)) {
    throw new Error(`Refusing to use ${label} because it is writable by another user: ${path}`);
  }
  if ((stats.mode & 0o700) !== 0o700) {
    throw new Error(
      `Refusing to use ${label} because it is not writable by the current user: ${path}`
    );
  }
  if (privateMode && process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(`Refusing to use ${label} because it is not private: ${path}`);
  }
  return true;
};

const assertOwnedAndStableFile = async (path: string, label: string) => {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use ${label} because it is a symbolic link: ${path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing to use ${label} because it is not a regular file: ${path}`);
  }
  if (!isOwnedByCurrentUser(stats)) {
    throw new Error(
      `Refusing to use ${label} because it is not owned by the current user: ${path}`
    );
  }
  if (isWritableByOtherUsers(stats)) {
    throw new Error(`Refusing to use ${label} because it is writable by another user: ${path}`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
    throw new Error(`Refusing to use ${label} because it is not private: ${path}`);
  }
  return stats;
};

const assertSafeTree = async (path: string, label: string) => {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use ${label} because it contains a symbolic link: ${path}`);
  }
  if (stats.isDirectory()) {
    if (!isOwnedByCurrentUser(stats) || isWritableByOtherUsers(stats)) {
      throw new Error(`Refusing to use ${label} because it contains an unsafe directory: ${path}`);
    }
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await assertSafeTree(join(path, entry.name), label);
    }
    return;
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing to use ${label} because it contains a non-regular entry: ${path}`);
  }
  if (!isOwnedByCurrentUser(stats) || isWritableByOtherUsers(stats)) {
    throw new Error(`Refusing to use ${label} because it contains an unsafe file: ${path}`);
  }
};

const ensureDirectory = async (path: string, label: string, privateMode = false) => {
  if (await assertOwnedAndStableDirectory(path, label, privateMode)) {
    return;
  }

  try {
    await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  } catch (cause) {
    if (!isCode(cause, "EEXIST")) {
      throw cause;
    }
  }
  await assertOwnedAndStableDirectory(path, label, privateMode);
};

const assertSafeAncestor = (path: string, stats: Stats, isHome: boolean) => {
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use the home path because it contains a symbolic link: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to use the home path because it is not a directory: ${path}`);
  }
  if (isHome && !isOwnedByCurrentUser(stats)) {
    throw new Error(
      `Refusing to use the home path because it is not owned by the current user: ${path}`
    );
  }
  if (isWritableByOtherUsers(stats)) {
    const sticky = process.platform !== "win32" && (stats.mode & 0o1000) !== 0;
    const worldWritable = process.platform !== "win32" && (stats.mode & 0o0002) !== 0;
    if (!sticky || !worldWritable) {
      throw new Error(`Refusing to use the home path because an ancestor is unsafe: ${path}`);
    }
  }
};

const ensureHomePath = async (homePath: string) => {
  const absolute = resolve(homePath);
  const root = parse(absolute).root;
  const segments = relative(root, absolute)
    .split(sep)
    .filter((segment) => segment.length > 0);
  let current = root;

  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let stats = await missingPath(current);
    if (stats === undefined) {
      try {
        await mkdir(current, { mode: PRIVATE_DIRECTORY_MODE });
      } catch (cause) {
        if (!isCode(cause, "EEXIST")) {
          throw cause;
        }
      }
      stats = await lstat(current);
    }
    assertSafeAncestor(current, stats, index === segments.length - 1);
  }

  if (segments.length === 0) {
    const stats = await lstat(root);
    assertSafeAncestor(root, stats, true);
  }
};

const validateSourceTree = async (path: string, label: string) => {
  const stats = await lstat(path);
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to bundle ${label} because it is a symbolic link: ${path}`);
  }
  if (stats.isDirectory()) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      await validateSourceTree(join(path, entry.name), label);
    }
    return;
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing to bundle ${label} because it contains a non-regular entry: ${path}`);
  }
};

const validateBundle = async () => {
  for (const skillName of SKILL_NAMES) {
    await validateSourceTree(join(bundledSkillsDirectory, skillName), `bundled ${skillName} skill`);
  }
};

const syncDirectory = async (path: string) => {
  if (process.platform === "win32") {
    return;
  }
  const directory = await open(path, constants.O_RDONLY | DIRECTORY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
};

const copyRegularFile = async (source: string, destination: string) => {
  let sourceFile: FileHandle | undefined;
  let destinationFile: FileHandle | undefined;
  try {
    sourceFile = await open(source, constants.O_RDONLY | NO_FOLLOW);
    const before = await sourceFile.stat();
    if (!before.isFile() || before.isSymbolicLink()) {
      throw new Error(`Refusing to copy a non-regular skill entry: ${source}`);
    }
    const contents = await sourceFile.readFile();
    const after = await sourceFile.stat();
    if (!sameIdentity(before, after)) {
      throw new Error(`The bundled skill file changed while it was being copied: ${source}`);
    }

    destinationFile = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      PRIVATE_FILE_MODE
    );
    await destinationFile.writeFile(contents);
    await destinationFile.sync();
  } finally {
    await destinationFile?.close();
    await sourceFile?.close();
  }
  await assertOwnedAndStableFile(destination, "staged skill file");
};

const copyTree = async (source: string, destination: string) => {
  const sourceStats = await lstat(source);
  if (sourceStats.isSymbolicLink()) {
    throw new Error(`Refusing to bundle a symbolic link: ${source}`);
  }
  if (!sourceStats.isDirectory()) {
    throw new Error(`Bundled skill is not a directory: ${source}`);
  }

  await mkdir(destination, { mode: PRIVATE_DIRECTORY_MODE });
  await assertOwnedAndStableDirectory(destination, "staged skill directory", true);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourceEntry = join(source, entry.name);
    const destinationEntry = join(destination, entry.name);
    const entryStats = await lstat(sourceEntry);
    if (entryStats.isSymbolicLink()) {
      throw new Error(`Refusing to bundle a symbolic link: ${sourceEntry}`);
    }
    if (entryStats.isDirectory()) {
      await copyTree(sourceEntry, destinationEntry);
    } else if (entryStats.isFile()) {
      await copyRegularFile(sourceEntry, destinationEntry);
    } else {
      throw new Error(`Refusing to bundle a non-regular skill entry: ${sourceEntry}`);
    }
  }
};

const writePrivateJson = async (path: string, value: unknown) => {
  const temporaryPath = `${path}.tmp-${randomBytes(12).toString("hex")}`;
  let file: FileHandle | undefined;
  try {
    file = await open(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      PRIVATE_FILE_MODE
    );
    await file.writeFile(JSON.stringify(value), "utf8");
    await file.sync();
  } finally {
    await file?.close();
  }
  await assertOwnedAndStableFile(temporaryPath, "transaction journal");
  const existing = await missingPath(path);
  if (existing !== undefined) {
    await assertOwnedAndStableFile(path, "transaction journal");
  }
  await rename(temporaryPath, path);
  await syncDirectory(dirname(path));
};

const readPrivateJson = async (path: string, label: string) => {
  const stats = await assertOwnedAndStableFile(path, label);
  const file = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await file.stat();
    if (!sameIdentity(stats, opened)) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    const contents = await file.readFile({ encoding: "utf8" });
    const after = await file.stat();
    if (!sameIdentity(stats, after)) {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    try {
      return JSON.parse(contents) as unknown;
    } catch {
      throw new Error(`${label} is malformed: ${path}`);
    }
  } finally {
    await file.close();
  }
};

type LockMetadata = Readonly<{
  readonly version: typeof LOCK_VERSION;
  readonly pid: number;
  readonly host: string;
  readonly token: string;
  readonly acquiredAt: number;
}>;

type LockObservation = Readonly<{
  readonly stats: Stats;
  readonly metadata: LockMetadata | undefined;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isLockMetadata = (value: unknown): value is LockMetadata => {
  if (!isRecord(value)) {
    return false;
  }
  const { version, pid, host, token, acquiredAt } = value;
  return (
    version === LOCK_VERSION &&
    typeof pid === "number" &&
    Number.isSafeInteger(pid) &&
    pid > 0 &&
    typeof host === "string" &&
    host.length > 0 &&
    typeof token === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/.test(token) &&
    typeof acquiredAt === "number" &&
    Number.isSafeInteger(acquiredAt) &&
    acquiredAt >= 0
  );
};

const processIsAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return !isCode(cause, "ESRCH");
  }
};

const observeLock = async (path: string) => {
  let stats: Stats;
  try {
    stats = await lstat(path);
  } catch (cause) {
    if (isCode(cause, "ENOENT")) {
      return undefined;
    }
    throw cause;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use the skills lock because it is a symbolic link: ${path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing to use the skills lock because it is not a regular file: ${path}`);
  }
  if (
    !isOwnedByCurrentUser(stats) ||
    isWritableByOtherUsers(stats) ||
    (process.platform !== "win32" && (stats.mode & 0o077) !== 0)
  ) {
    throw new Error(
      `Refusing to use the skills lock because its ownership or mode is unsafe: ${path}`
    );
  }

  const file = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const opened = await file.stat();
    if (!sameIdentity(stats, opened)) {
      return undefined;
    }
    const contents = await file.readFile({ encoding: "utf8" });
    const after = await file.stat();
    if (!sameIdentity(stats, after)) {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch {
      parsed = undefined;
    }
    return {
      stats,
      metadata: isLockMetadata(parsed) ? parsed : undefined,
    } satisfies LockObservation;
  } finally {
    await file.close();
  }
};

const removeLockIfSame = async (path: string, observation: LockObservation) => {
  let current: Stats;
  try {
    current = await lstat(path);
  } catch (cause) {
    if (isCode(cause, "ENOENT")) {
      return false;
    }
    throw cause;
  }
  if (!sameIdentity(observation.stats, current)) {
    return false;
  }
  try {
    await unlink(path);
  } catch (cause) {
    if (isCode(cause, "ENOENT")) {
      return false;
    }
    throw cause;
  }
  await syncDirectory(dirname(path));
  return true;
};

const wait = (milliseconds: number) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const acquireSkillsLock = async (skillsDirectory: string) => {
  const path = join(skillsDirectory, SKILLS_LOCK_NAME);
  const token = randomBytes(32).toString("base64url");
  const metadata = {
    version: LOCK_VERSION,
    pid: process.pid,
    host: LOCAL_HOSTNAME,
    token,
    acquiredAt: Date.now(),
  } satisfies LockMetadata;
  const deadline = Date.now() + LOCK_WAIT_MS;

  while (true) {
    let file: FileHandle | undefined;
    let createdIdentity: Stats | undefined;
    try {
      file = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        PRIVATE_FILE_MODE
      );
      createdIdentity = await file.stat();
      await file.writeFile(JSON.stringify(metadata), "utf8");
      await file.sync();
      createdIdentity = await file.stat();
      await file.close();
      file = undefined;
      const current = await lstat(path);
      if (!sameIdentity(createdIdentity, current)) {
        throw new Error("The skills lock changed immediately after acquisition.");
      }
      await syncDirectory(skillsDirectory);
      return {
        release: async () => {
          const observation = await observeLock(path);
          if (observation?.metadata?.token === token) {
            await removeLockIfSame(path, observation);
          }
        },
      };
    } catch (cause) {
      await file?.close().catch(() => undefined);
      if (!isCode(cause, "EEXIST")) {
        if (createdIdentity !== undefined) {
          try {
            const current = await lstat(path);
            if (sameIdentity(createdIdentity, current)) {
              await unlink(path);
            }
          } catch (cleanupCause) {
            if (!isCode(cleanupCause, "ENOENT")) {
              throw new Error(
                `Could not acquire the skills lock: ${describe(cause)}; cleanup also failed: ${describe(cleanupCause)}`
              );
            }
          }
        }
        throw cause;
      }

      let observation: LockObservation | undefined;
      try {
        observation = await observeLock(path);
      } catch (observationCause) {
        if (isCode(observationCause, "ENOENT")) {
          continue;
        }
        throw observationCause;
      }
      if (observation === undefined) {
        continue;
      }
      const lockAge = Date.now() - (observation.metadata?.acquiredAt ?? observation.stats.mtimeMs);
      const stale = lockAge >= LOCK_RECOVERY_GRACE_MS;
      const recoverable =
        stale &&
        (observation.metadata === undefined ||
          (observation.metadata.host === LOCAL_HOSTNAME &&
            !processIsAlive(observation.metadata.pid)));
      if (recoverable) {
        if (await removeLockIfSame(path, observation)) {
          continue;
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          "Another Planview skills installation is in progress, or its lock is malformed and not yet safely recoverable."
        );
      }
      await wait(25);
    }
  }
};

type TransactionPhase = "staging" | "installing" | "committed";
type JournalEntry = Readonly<{
  readonly name: SkillName;
  readonly previous: FileIdentity | null;
  readonly staged: FileIdentity | null;
  readonly installed: FileIdentity | null;
  readonly backedUp: boolean;
  readonly installedFlag: boolean;
}>;
type JournalEntries = Readonly<{
  readonly planview: JournalEntry;
  readonly "create-html": JournalEntry;
}>;
type TransactionJournal = Readonly<{
  readonly version: typeof TRANSACTION_VERSION;
  readonly token: string;
  readonly phase: TransactionPhase;
  readonly entries: JournalEntries;
}>;

const isFileIdentity = (value: unknown): value is FileIdentity => {
  if (!isRecord(value)) {
    return false;
  }
  const { dev, ino, size, mtimeMs, mode } = value;
  return (
    typeof dev === "number" &&
    Number.isSafeInteger(dev) &&
    dev >= 0 &&
    typeof ino === "number" &&
    Number.isSafeInteger(ino) &&
    ino >= 0 &&
    typeof size === "number" &&
    Number.isSafeInteger(size) &&
    size >= 0 &&
    typeof mtimeMs === "number" &&
    Number.isFinite(mtimeMs) &&
    typeof mode === "number" &&
    Number.isSafeInteger(mode) &&
    mode >= 0
  );
};

const isJournalEntry = (value: unknown, expectedName: SkillName): value is JournalEntry => {
  if (!isRecord(value)) {
    return false;
  }
  const { name, previous, staged, installed, backedUp, installedFlag } = value;
  return (
    name === expectedName &&
    (previous === null || isFileIdentity(previous)) &&
    (staged === null || isFileIdentity(staged)) &&
    (installed === null || isFileIdentity(installed)) &&
    typeof backedUp === "boolean" &&
    typeof installedFlag === "boolean"
  );
};

const isTransactionJournal = (value: unknown): value is TransactionJournal => {
  if (!isRecord(value)) {
    return false;
  }
  const { version, token, phase, entries } = value;
  return (
    version === TRANSACTION_VERSION &&
    typeof token === "string" &&
    /^[A-Za-z0-9_-]{32,128}$/.test(token) &&
    (phase === "staging" || phase === "installing" || phase === "committed") &&
    isRecord(entries) &&
    isJournalEntry(Reflect.get(entries, "planview"), "planview") &&
    isJournalEntry(Reflect.get(entries, "create-html"), "create-html")
  );
};

const readJournal = async (transactionDirectory: string) => {
  const path = join(transactionDirectory, JOURNAL_NAME);
  try {
    const parsed = await readPrivateJson(path, "skills transaction journal");
    if (!isTransactionJournal(parsed)) {
      throw new Error(`Skills transaction journal is invalid: ${path}`);
    }
    return parsed;
  } catch (cause) {
    if (isCode(cause, "ENOENT")) {
      return undefined;
    }
    throw cause;
  }
};

const makeJournal = (previous: ReadonlyMap<SkillName, Stats>) => {
  const entry = (name: SkillName) => {
    const previousStats = previous.get(name);
    return {
      name,
      previous: previousStats === undefined ? null : identityFromStats(previousStats),
      staged: null,
      installed: null,
      backedUp: false,
      installedFlag: false,
    } satisfies JournalEntry;
  };
  return {
    version: TRANSACTION_VERSION,
    token: randomBytes(32).toString("base64url"),
    phase: "staging" as TransactionPhase,
    entries: {
      planview: entry("planview"),
      "create-html": entry("create-html"),
    },
  } satisfies TransactionJournal;
};

const updateJournalEntry = (
  journal: TransactionJournal,
  name: SkillName,
  update: Partial<JournalEntry>
) => ({
  ...journal,
  entries: {
    ...journal.entries,
    [name]: { ...journal.entries[name], ...update },
  },
});

const updateJournalPhase = (journal: TransactionJournal, phase: TransactionPhase) => ({
  ...journal,
  phase,
});

const transactionDirectoryName = (name: string) =>
  name.startsWith(TRANSACTION_PREFIX) && name.length > TRANSACTION_PREFIX.length;

const transactionPathEntries = async (skillsDirectory: string) => {
  const transactions: string[] = [];
  for (const entry of await readdir(skillsDirectory, { withFileTypes: true })) {
    if (!transactionDirectoryName(entry.name)) {
      continue;
    }
    const path = join(skillsDirectory, entry.name);
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`Refusing to recover a symbolic-link skills transaction: ${path}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`Refusing to recover a non-directory skills transaction: ${path}`);
    }
    if (!isOwnedByCurrentUser(stats) || isWritableByOtherUsers(stats)) {
      throw new Error(`Refusing to recover an unsafe skills transaction: ${path}`);
    }
    transactions.push(path);
  }
  return transactions;
};

const removeOwnedTree = async (path: string, expected: FileIdentity | null, label: string) => {
  const stats = await missingPath(path);
  if (stats === undefined) {
    return;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to remove ${label} because it is a symbolic link: ${path}`);
  }
  if (expected !== null && !sameObjectIdentity(stats, expected)) {
    throw new Error(`Refusing to remove ${label} because it changed unexpectedly: ${path}`);
  }
  if (expected === null) {
    throw new Error(`Refusing to remove unexpected ${label}: ${path}`);
  }
  await assertSafeTree(path, label);
  await rm(path, { recursive: true, force: true });
};

const observeDirectoryIdentity = async (path: string, label: string) => {
  const stats = await missingPath(path);
  if (stats === undefined) {
    return undefined;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to inspect ${label} because it is a symbolic link: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Refusing to inspect ${label} because it is not a directory: ${path}`);
  }
  return stats;
};

const requireDirectoryIdentity = async (path: string, label: string) => {
  const stats = await observeDirectoryIdentity(path, label);
  if (stats === undefined) {
    throw new Error(`The ${label} is missing: ${path}`);
  }
  return stats;
};

const restorePreviousEntry = async (
  skillsDirectory: string,
  transactionDirectory: string,
  entry: JournalEntry
) => {
  const target = join(skillsDirectory, entry.name);
  const previous = join(transactionDirectory, PREVIOUS_DIRECTORY_NAME, entry.name);
  const staged = join(transactionDirectory, entry.name);
  const targetStats = await observeDirectoryIdentity(target, `installed ${entry.name} skill`);
  const previousStats = await observeDirectoryIdentity(previous, `previous ${entry.name} skill`);
  const stagedStats = await observeDirectoryIdentity(staged, `staged ${entry.name} skill`);

  if (entry.previous === null) {
    if (previousStats !== undefined) {
      throw new Error(`Unexpected previous ${entry.name} skill during recovery: ${previous}`);
    }
    if (targetStats !== undefined) {
      if (entry.staged === null || !sameObjectIdentity(targetStats, entry.staged)) {
        throw new Error(`Refusing to replace an unexpected ${entry.name} skill during recovery.`);
      }
      await removeOwnedTree(target, entry.staged, `installed ${entry.name} skill`);
    }
  } else if (targetStats !== undefined && sameRecordedIdentity(targetStats, entry.previous)) {
    if (previousStats !== undefined) {
      throw new Error(`Both old and backup ${entry.name} skills are present during recovery.`);
    }
  } else {
    if (previousStats === undefined || !sameRecordedIdentity(previousStats, entry.previous)) {
      throw new Error(`The previous ${entry.name} skill is missing or changed during recovery.`);
    }
    if (targetStats !== undefined) {
      if (entry.staged === null || !sameObjectIdentity(targetStats, entry.staged)) {
        throw new Error(`Refusing to replace an unexpected ${entry.name} skill during recovery.`);
      }
      await removeOwnedTree(target, entry.staged, `installed ${entry.name} skill`);
    }
    await rename(previous, target);
    await syncDirectory(skillsDirectory);
    const restored = await observeDirectoryIdentity(target, `restored ${entry.name} skill`);
    if (restored === undefined || !sameRecordedIdentity(restored, entry.previous)) {
      throw new Error(`The previous ${entry.name} skill was not restored safely.`);
    }
  }

  if (stagedStats !== undefined) {
    if (entry.staged === null || !sameObjectIdentity(stagedStats, entry.staged)) {
      throw new Error(`Refusing to remove an unexpected staged ${entry.name} skill.`);
    }
    await removeOwnedTree(staged, entry.staged, `staged ${entry.name} skill`);
  }
};

const finishCommittedEntry = async (
  skillsDirectory: string,
  transactionDirectory: string,
  entry: JournalEntry
) => {
  const target = join(skillsDirectory, entry.name);
  const previous = join(transactionDirectory, PREVIOUS_DIRECTORY_NAME, entry.name);
  const staged = join(transactionDirectory, entry.name);
  const targetStats = await observeDirectoryIdentity(target, `installed ${entry.name} skill`);
  if (
    targetStats === undefined ||
    entry.staged === null ||
    !sameRecordedIdentity(targetStats, entry.staged)
  ) {
    throw new Error(`The committed ${entry.name} skill is missing or changed: ${target}`);
  }
  await assertSafeTree(target, `committed ${entry.name} skill`);
  const previousStats = await observeDirectoryIdentity(previous, `previous ${entry.name} skill`);
  if (previousStats !== undefined) {
    if (entry.previous === null || !sameObjectIdentity(previousStats, entry.previous)) {
      throw new Error(`Refusing to remove an unexpected previous ${entry.name} skill.`);
    }
    await removeOwnedTree(previous, entry.previous, `previous ${entry.name} skill`);
  } else if (entry.previous !== null) {
    // A prior recovery may already have completed this cleanup.
  }
  const stagedStats = await observeDirectoryIdentity(staged, `staged ${entry.name} skill`);
  if (stagedStats !== undefined) {
    if (!sameRecordedIdentity(stagedStats, entry.staged)) {
      throw new Error(`Refusing to remove an unexpected staged ${entry.name} skill.`);
    }
    await removeOwnedTree(staged, entry.staged, `staged ${entry.name} skill`);
  }
};

const removeTransactionDirectory = async (transactionDirectory: string) => {
  await assertSafeTree(transactionDirectory, "skills transaction");
  await rm(transactionDirectory, { recursive: true, force: true });
  await syncDirectory(dirname(transactionDirectory));
};

const recoverTransaction = async (transactionDirectory: string) => {
  const journal = await readJournal(transactionDirectory);
  if (journal === undefined) {
    // The journal is created before any destination is touched. A crash before
    // that durable point can therefore only leave an incomplete staging tree.
    await removeTransactionDirectory(transactionDirectory);
    return;
  }

  if (journal.phase === "staging") {
    await removeTransactionDirectory(transactionDirectory);
    return;
  }

  if (journal.phase === "installing") {
    for (const skillName of [...SKILL_NAMES].reverse()) {
      await restorePreviousEntry(
        dirname(transactionDirectory),
        transactionDirectory,
        journal.entries[skillName]
      );
    }
  } else {
    for (const skillName of SKILL_NAMES) {
      await finishCommittedEntry(
        dirname(transactionDirectory),
        transactionDirectory,
        journal.entries[skillName]
      );
    }
  }

  const previousDirectory = join(transactionDirectory, PREVIOUS_DIRECTORY_NAME);
  const previousStats = await observeDirectoryIdentity(
    previousDirectory,
    "skills transaction backup"
  );
  if (previousStats !== undefined) {
    await assertSafeTree(previousDirectory, "skills transaction backup");
    await rm(previousDirectory, { recursive: true, force: true });
  }
  await removeTransactionDirectory(transactionDirectory);
};

const recoverTransactions = async (skillsDirectory: string) => {
  for (const transactionDirectory of await transactionPathEntries(skillsDirectory)) {
    await recoverTransaction(transactionDirectory);
  }
};

const maybeTestCrash = async (point: string) => {
  if (process.env[TEST_CRASH_ENV] === point) {
    process.kill(process.pid, "SIGKILL");
  }
};

const maybeTestPause = async (point: string) => {
  const configured = process.env[TEST_PAUSE_ENV];
  const milliseconds = configured === undefined ? 0 : Number(configured);
  if (
    Number.isFinite(milliseconds) &&
    milliseconds > 0 &&
    process.env[TEST_PAUSE_AT_ENV] === point
  ) {
    await wait(milliseconds);
  }
};

const installTransaction = async (
  skillsDirectory: string,
  existing: ReadonlyMap<SkillName, Stats>
) => {
  const transactionDirectory = await mkdtemp(join(skillsDirectory, TRANSACTION_PREFIX));
  await assertOwnedAndStableDirectory(transactionDirectory, "skills transaction", true);
  let journal: TransactionJournal = makeJournal(existing);
  const journalPath = join(transactionDirectory, JOURNAL_NAME);
  await writePrivateJson(journalPath, journal);

  try {
    for (const skillName of SKILL_NAMES) {
      await copyTree(
        join(bundledSkillsDirectory, skillName),
        join(transactionDirectory, skillName)
      );
    }
    journal = {
      ...journal,
      entries: {
        planview: {
          ...journal.entries.planview,
          staged: identityFromStats(
            await requireDirectoryIdentity(
              join(transactionDirectory, "planview"),
              "staged planview skill"
            )
          ),
        },
        "create-html": {
          ...journal.entries["create-html"],
          staged: identityFromStats(
            await requireDirectoryIdentity(
              join(transactionDirectory, "create-html"),
              "staged create-html skill"
            )
          ),
        },
      },
    };
    await writePrivateJson(journalPath, journal);
    await maybeTestCrash("after-stage");

    await mkdir(join(transactionDirectory, PREVIOUS_DIRECTORY_NAME), {
      mode: PRIVATE_DIRECTORY_MODE,
    });
    await assertOwnedAndStableDirectory(
      join(transactionDirectory, PREVIOUS_DIRECTORY_NAME),
      "skills transaction backup",
      true
    );
    journal = updateJournalPhase(journal, "installing");
    await writePrivateJson(journalPath, journal);
    await maybeTestPause("after-lock");

    for (const skillName of SKILL_NAMES) {
      const entry = journal.entries[skillName];
      const target = join(skillsDirectory, skillName);
      const previous = join(transactionDirectory, PREVIOUS_DIRECTORY_NAME, skillName);
      const staged = join(transactionDirectory, skillName);
      const targetStats = await observeDirectoryIdentity(target, `existing ${skillName} skill`);
      if (entry.previous !== null) {
        if (targetStats === undefined || !sameRecordedIdentity(targetStats, entry.previous)) {
          throw new Error(`The existing ${skillName} skill changed before installation.`);
        }
        const existingPrevious = await missingPath(previous);
        if (existingPrevious !== undefined) {
          throw new Error(`The backup path for ${skillName} already exists: ${previous}`);
        }
        await rename(target, previous);
        await syncDirectory(skillsDirectory);
        const backedUp = await observeDirectoryIdentity(previous, `previous ${skillName} skill`);
        if (backedUp === undefined || !sameRecordedIdentity(backedUp, entry.previous)) {
          throw new Error(`The existing ${skillName} skill was not backed up safely.`);
        }
      } else if (targetStats !== undefined) {
        throw new Error(`An unexpected ${skillName} skill appeared during installation.`);
      }
      await maybeTestCrash(`after-backup-${skillName}`);

      const stagedStats = await observeDirectoryIdentity(staged, `staged ${skillName} skill`);
      if (
        stagedStats === undefined ||
        entry.staged === null ||
        !sameRecordedIdentity(stagedStats, entry.staged)
      ) {
        throw new Error(`The staged ${skillName} skill changed before installation.`);
      }
      const targetBeforeInstall = await missingPath(target);
      if (targetBeforeInstall !== undefined) {
        throw new Error(`The ${skillName} skill appeared during installation.`);
      }
      await rename(staged, target);
      await syncDirectory(skillsDirectory);
      const installed = await observeDirectoryIdentity(target, `installed ${skillName} skill`);
      if (installed === undefined || !sameRecordedIdentity(installed, entry.staged)) {
        throw new Error(`The ${skillName} skill was not installed safely.`);
      }
      journal = updateJournalEntry(journal, skillName, {
        backedUp: true,
        installed: entry.staged,
        installedFlag: true,
      });
      await writePrivateJson(journalPath, journal);
      await maybeTestCrash(`after-install-${skillName}`);
    }

    journal = updateJournalPhase(journal, "committed");
    await writePrivateJson(journalPath, journal);
    await maybeTestCrash("after-commit");

    for (const skillName of SKILL_NAMES) {
      const entry = journal.entries[skillName];
      if (entry.previous !== null) {
        await removeOwnedTree(
          join(transactionDirectory, PREVIOUS_DIRECTORY_NAME, skillName),
          entry.previous,
          `previous ${skillName} skill`
        );
        await maybeTestCrash(`after-remove-previous-${skillName}`);
      }
    }
    await removeTransactionDirectory(transactionDirectory);
  } catch (cause) {
    try {
      await recoverTransaction(transactionDirectory);
    } catch (recoveryCause) {
      throw new AggregateError(
        [cause, recoveryCause],
        `Skills installation failed and recovery was deferred: ${describe(cause)}; ${describe(recoveryCause)}`
      );
    }
    throw cause;
  }
};

const readExistingSkills = async (skillsDirectory: string) => {
  const existing = new Map<SkillName, Stats>();
  for (const skillName of SKILL_NAMES) {
    const path = join(skillsDirectory, skillName);
    const stats = await missingPath(path);
    if (stats === undefined) {
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(
        `Refusing to use existing ${skillName} skill because it is a symbolic link: ${path}`
      );
    }
    await assertOwnedAndStableDirectory(path, `existing ${skillName} skill`);
    await assertSafeTree(path, `existing ${skillName} skill`);
    existing.set(skillName, stats);
  }
  return existing;
};

export const skillsInstallPath = () => join(homedir(), ".agents", "skills");

export const installSkills = async ({ force = false } = {}) => {
  await validateBundle();

  const home = homedir();
  await ensureHomePath(home);
  const agentsDirectory = join(home, ".agents");
  const skillsDirectory = join(agentsDirectory, "skills");
  await ensureDirectory(agentsDirectory, "~/.agents");
  await ensureDirectory(skillsDirectory, "~/.agents/skills");

  const lock = await acquireSkillsLock(skillsDirectory);
  try {
    await recoverTransactions(skillsDirectory);
    const existing = await readExistingSkills(skillsDirectory);
    if (!force && existing.size > 0) {
      const names = [...existing.keys()].join(", ");
      throw new Error(
        `Skill directory already exists: ${names}. Use --force to replace existing bundled skills.`
      );
    }
    await installTransaction(skillsDirectory, existing);
    return skillsDirectory;
  } finally {
    await lock.release();
  }
};

export { SKILL_NAMES };
