import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { renameSync, symlinkSync } from "node:fs";
import { promisify } from "node:util";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  DocumentFileAlreadyExistsError,
  DocumentFileNotRegularError,
  DocumentFileStoreClosedError,
  DocumentFileStorePathError,
  InvalidStagedDocumentFileHandleError,
  openDocumentFileStore,
} from "../dist/index.js";

const V1_MAX_HTML_SIZE_BYTES = 10 * 1024 * 1024;
const execFileAsync = promisify(execFile);

const withTempDirectory = async (callback) => {
  const directory = await mkdtemp(join(tmpdir(), "planview-document-files-"));
  try {
    return await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const validId = "a".repeat(21);
const otherId = "b".repeat(21);

const withStore = (callback) =>
  withTempDirectory(async (directory) => {
    const store = Effect.runSync(
      openDocumentFileStore({
        documentsDir: join(directory, "documents"),
        stagingDir: join(directory, "staging"),
      })
    );
    try {
      return await callback({ directory, store });
    } finally {
      await store.close();
    }
  });

const readStream = async (stream) => Buffer.concat(await stream.toArray());

const waitForChild = (child, timeoutMs) =>
  new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({ error, code: null, timedOut });
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut });
    });
  });

const createFifo = async (path) => {
  if (process.platform === "win32") {
    return false;
  }
  try {
    await execFileAsync("mkfifo", [path]);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EPERM" || error?.code === "EACCES") {
      return false;
    }
    throw error;
  }
};

test("initializes private owned directories and safe staged files", () =>
  withStore(async ({ directory, store }) => {
    const documents = await stat(join(directory, "documents"));
    const staging = await stat(join(directory, "staging"));
    if (process.platform !== "win32") {
      assert.equal(documents.mode & 0o777, 0o700);
      assert.equal(staging.mode & 0o777, 0o700);
    }

    const source = join(directory, "source.html");
    await writeFile(source, "<p>safe</p>");
    const handle = await store.stageSourceFile(source);
    const staged = await stat(join(directory, "staging", handle));
    if (process.platform !== "win32") {
      assert.equal(staged.mode & 0o777, 0o600);
    }
  }));

test("copies a valid source without mutating it and survives source changes", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "input.HTML");
    const original = Buffer.from("<html><body>original</body></html>");
    await writeFile(source, original);
    const handle = await store.stageSourceFile(source);
    assert.deepEqual(await readFile(source), original);

    await writeFile(source, "changed");
    await store.finalizeStagedFile(handle, validId);
    await rm(source);
    const stream = await store.readDocument(validId);
    assert.deepEqual(await readStream(stream), original);
  }));

test("accepts exactly 10 MiB and rejects oversize sources with staging cleanup", () =>
  withStore(async ({ directory, store }) => {
    const exact = join(directory, "exact.html");
    await writeFile(exact, "");
    await truncate(exact, V1_MAX_HTML_SIZE_BYTES);
    const handle = await store.stageSourceFile(exact);
    assert.equal((await stat(join(directory, "staging", handle))).size, V1_MAX_HTML_SIZE_BYTES);
    await store.finalizeStagedFile(handle, validId);

    const oversized = join(directory, "oversized.html");
    await writeFile(oversized, "");
    await truncate(oversized, V1_MAX_HTML_SIZE_BYTES + 1);
    await assert.rejects(
      store.stageSourceFile(oversized),
      (error) => error.name === "SourceFileTooLargeError"
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("rejects malformed extensions, directories, and symlinks", () =>
  withStore(async ({ directory, store }) => {
    const malformed = join(directory, "input.txt");
    await writeFile(malformed, "not html");
    await assert.rejects(store.stageSourceFile(malformed), /only \.html and \.htm/);

    const directorySource = join(directory, "directory.html");
    await mkdir(directorySource);
    await assert.rejects(
      store.stageSourceFile(directorySource),
      (error) => error instanceof DocumentFileNotRegularError
    );

    const linked = join(directory, "linked.html");
    try {
      await symlink(malformed, linked);
      await assert.rejects(
        store.stageSourceFile(linked),
        (error) => error instanceof DocumentFileNotRegularError
      );
    } catch (error) {
      if (error?.code !== "EPERM" && error?.code !== "EACCES") {
        throw error;
      }
    }
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("rejects a FIFO in a bounded child process without opening it blocking", async (t) => {
  const probe = join(tmpdir(), `planview-fifo-probe-${process.pid}-${Date.now()}`);
  const fifoAvailable = await createFifo(probe);
  await rm(probe, { force: true });
  if (!fifoAvailable) {
    t.skip("mkfifo is unavailable on this platform");
    return;
  }

  await withTempDirectory(async (directory) => {
    const fifo = join(directory, "input.html");
    await execFileAsync("mkfifo", [fifo]);
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    await mkdir(documentsDir);
    await mkdir(stagingDir);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./fifo-stage-worker.mjs", import.meta.url)),
        fifo,
        documentsDir,
        stagingDir,
      ],
      { stdio: "ignore" }
    );
    const result = await waitForChild(child, 1_000);
    assert.equal(result.timedOut, false, "FIFO validation must not leave an open() request hung");
    assert.equal(result.code, 0);
  });
});

test("rejects a source replaced while it is being staged and cleans up", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "raced.html");
    const replacement = join(directory, "replacement.html");
    await writeFile(source, Buffer.alloc(V1_MAX_HTML_SIZE_BYTES, 0x61));
    const staging = store.stageSourceFile(source);
    renameSync(source, replacement);
    symlinkSync(replacement, source);
    await assert.rejects(
      staging,
      (error) =>
        error.name === "DocumentFileSourceError" ||
        error.name === "DocumentFileNotRegularError" ||
        error.name === "SourceFileTooLargeError"
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("rejects streamed source growth above the limit and cleans up", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "growing.html");
    await writeFile(source, Buffer.alloc(V1_MAX_HTML_SIZE_BYTES, 0x62));
    const staging = store.stageSourceFile(source);
    await appendFile(source, "x");
    await assert.rejects(
      staging,
      (error) =>
        error.name === "SourceFileTooLargeError" || error.name === "DocumentFileSourceError"
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("rejects symlinked or replaced storage parents before using them", async () => {
  await withTempDirectory(async (directory) => {
    const outside = await mkdtemp(join(tmpdir(), "planview-outside-"));
    const linkedParent = join(directory, "linked-parent");
    await symlink(outside, linkedParent);
    assert.throws(
      () =>
        Effect.runSync(
          openDocumentFileStore({
            documentsDir: join(linkedParent, "documents"),
            stagingDir: join(directory, "staging"),
          })
        ),
      (error) => error instanceof DocumentFileStorePathError
    );
    await rm(outside, { recursive: true, force: true });
  });

  await withStore(async ({ directory, store }) => {
    const documents = join(directory, "documents");
    const outside = await mkdtemp(join(tmpdir(), "planview-replaced-"));
    await rm(documents, { recursive: true, force: true });
    await symlink(outside, documents);
    await assert.rejects(
      store.readDocument(validId),
      (error) => error instanceof DocumentFileStorePathError
    );
    await rm(documents, { force: true });
    await rm(outside, { recursive: true, force: true });
  });
});

test("rejects nonregular and symlink final targets without replacing them", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "input.html");
    await writeFile(source, "target safety");
    const outside = join(directory, "outside.html");
    await writeFile(outside, "outside");
    const target = join(directory, "documents", `${validId}.html`);
    await symlink(outside, target);
    const symlinkHandle = await store.stageSourceFile(source);
    await assert.rejects(
      store.finalizeStagedFile(symlinkHandle, validId),
      (error) => error instanceof DocumentFileNotRegularError
    );
    assert.equal(await readFile(outside, "utf8"), "outside");
    assert.deepEqual(await readdir(join(directory, "staging")), []);
    await rm(target, { force: true });

    await mkdir(target);
    const directoryHandle = await store.stageSourceFile(source);
    await assert.rejects(
      store.finalizeStagedFile(directoryHandle, validId),
      (error) => error instanceof DocumentFileNotRegularError
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
    await rm(target, { recursive: true, force: true });
  }));

test("close waits for an active operation and rejects new operations", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "active.html");
    await writeFile(source, Buffer.alloc(V1_MAX_HTML_SIZE_BYTES, 0x63));
    const staging = store.stageSourceFile(source);
    const closing = store.close();

    await assert.rejects(
      store.stageSourceFile(source),
      (error) => error instanceof DocumentFileStoreClosedError
    );
    const handle = await staging;
    await closing;
    assert.equal((await stat(join(directory, "staging", handle))).isFile(), true);
    await assert.rejects(
      store.readDocument(validId),
      (error) => error instanceof DocumentFileStoreClosedError
    );
  }));

test("recovers a crash-stale finalization lock", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "stale.html");
    await writeFile(source, "stale lock");
    const handle = await store.stageSourceFile(source);
    const lockPath = join(directory, "staging", `.${handle}.lock`);
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL("./finalization-lock-worker.mjs", import.meta.url)), lockPath],
      { stdio: "ignore" }
    );
    const result = await waitForChild(child, 1_000);
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 42);

    await store.finalizeStagedFile(handle, validId);
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("does not recover an expired lock whose owner is still active", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "active-lock.html");
    await writeFile(source, "active lock");
    const handle = await store.stageSourceFile(source);
    const lockPath = join(directory, "staging", `.${handle}.lock`);
    await mkdir(lockPath);
    const now = Date.now();
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({
        version: 1,
        owner: { pid: process.pid, host: hostname(), token: "active-lock" },
        acquiredAt: now - 60_000,
        leaseExpiresAt: now - 30_000,
      })
    );

    await assert.rejects(store.finalizeStagedFile(handle, validId), /already being finalized/);
    assert.equal((await stat(join(directory, "staging", handle))).isFile(), true);
    assert.equal((await stat(lockPath)).isDirectory(), true);
    await rm(lockPath, { recursive: true, force: true });
    await store.finalizeStagedFile(handle, validId);
  }));

test("concurrent finalization of one id has one atomic winner", () =>
  withTempDirectory(async (directory) => {
    const documentsDir = join(directory, "documents");
    const stagingDir = join(directory, "staging");
    const firstStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
    const secondStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
    try {
      const firstSource = join(directory, "first.html");
      const secondSource = join(directory, "second.html");
      await writeFile(firstSource, "first");
      await writeFile(secondSource, "second");
      const firstHandle = await firstStore.stageSourceFile(firstSource);
      const secondHandle = await secondStore.stageSourceFile(secondSource);
      const results = await Promise.allSettled([
        firstStore.finalizeStagedFile(firstHandle, validId),
        secondStore.finalizeStagedFile(secondHandle, validId),
      ]);
      assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
      assert.equal(results.filter((result) => result.status === "rejected").length, 1);
      const rejected = results.find((result) => result.status === "rejected");
      assert.equal(rejected.reason instanceof DocumentFileAlreadyExistsError, true);
      assert.deepEqual(await readdir(stagingDir), []);
      const published = await readFile(join(documentsDir, `${validId}.html`));
      assert.equal(
        [Buffer.from("first"), Buffer.from("second")].some((contents) =>
          contents.equals(published)
        ),
        true
      );
    } finally {
      firstStore.close();
      secondStore.close();
    }
  }));

test("finalization uses a validated id, consumes the handle, and never replaces a file", () =>
  withStore(async ({ directory, store }) => {
    const source = join(directory, "input.html");
    await writeFile(source, "first");
    const handle = await store.stageSourceFile(source);
    await store.finalizeStagedFile(handle, validId);
    await assert.rejects(store.readDocument("../escape"), /Document id must be exactly/);
    await assert.rejects(
      store.finalizeStagedFile("../escape", otherId),
      (error) => error instanceof InvalidStagedDocumentFileHandleError
    );

    await writeFile(source, "second");
    const duplicateHandle = await store.stageSourceFile(source);
    await assert.rejects(
      store.finalizeStagedFile(duplicateHandle, validId),
      (error) => error instanceof DocumentFileAlreadyExistsError
    );
    assert.deepEqual(
      await readFile(join(directory, "documents", `${validId}.html`)),
      Buffer.from("first")
    );
    assert.deepEqual(await readdir(join(directory, "staging")), []);
  }));

test("reads and deletes safely, including missing documents", () =>
  withStore(async ({ directory, store }) => {
    await assert.rejects(store.readDocument(otherId), /Could not open document file/);
    assert.equal(await store.deleteDocumentFile(otherId), false);
    await assert.rejects(
      store.deleteDocumentFile("../../etc/passwd"),
      /Document id must be exactly/
    );

    const source = join(directory, "input.html");
    await writeFile(source, "read me");
    const handle = await store.stageSourceFile(source);
    await store.finalizeStagedFile(handle, otherId);
    assert.equal((await readStream(await store.readDocument(otherId))).toString(), "read me");
    assert.equal(await store.deleteDocumentFile(otherId), true);
    assert.equal(await store.deleteDocumentFile(otherId), false);
    assert.deepEqual(await readdir(join(directory, "documents")), []);
  }));

test("cleans a failed finalization and reports path initialization errors", async () => {
  await withStore(async ({ directory, store }) => {
    const source = join(directory, "input.html");
    await writeFile(source, "cleanup");
    const handle = await store.stageSourceFile(source);
    await rm(join(directory, "staging", handle));
    await assert.rejects(store.finalizeStagedFile(handle, validId));
    assert.deepEqual(await readdir(join(directory, "staging")), []);
    store.close();
    await assert.rejects(
      store.stageSourceFile(source),
      (error) => error instanceof DocumentFileStoreClosedError
    );
  });

  assert.throws(
    () =>
      Effect.runSync(
        openDocumentFileStore({ documentsDir: "relative", stagingDir: "/tmp/staging" })
      ),
    (error) => error instanceof DocumentFileStorePathError
  );
});
