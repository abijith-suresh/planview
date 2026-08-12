import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  createDocumentCleanupCoordinator,
  createMetadataGatedDocumentReader,
  V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS,
  openDocumentFileStore,
  openStorage,
} from "../dist/index.js";

const DAY = 24 * 60 * 60 * 1000;
const id = (character) => character.repeat(21);

const withEnvironment = async (callback, options = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "planview-cleanup-"));
  const documentFileStore = Effect.runSync(
    openDocumentFileStore({
      documentsDir: join(directory, "documents"),
      stagingDir: join(directory, "staging"),
      ...options,
    })
  );
  const metadataStore = Effect.runSync(openStorage(join(directory, "metadata.sqlite")));
  try {
    return await callback({
      directory,
      documentsDir: join(directory, "documents"),
      stagingDir: join(directory, "staging"),
      documentFileStore,
      metadataStore,
    });
  } finally {
    await documentFileStore.close();
    metadataStore.close();
    await rm(directory, { recursive: true, force: true });
  }
};

const publishPhysical = async (environment, documentId, contents) => {
  const source = join(environment.directory, `${documentId}.source.html`);
  await writeFile(source, contents);
  const handle = await environment.documentFileStore.stageSourceFile(source);
  await environment.documentFileStore.finalizeStagedFile(handle, documentId);
  environment.metadataStore.insertDocumentMetadata({
    id: documentId,
    createdAt: 1,
    lastAccessedAt: 1,
    size: Buffer.byteLength(contents),
  });
};

test("retains the exact 30-day boundary and deletes only older lastAccessed rows", () =>
  withEnvironment(async ({ documentFileStore, metadataStore, directory }) => {
    await publishPhysical({ documentFileStore, metadataStore, directory }, id("a"), "old");
    await publishPhysical({ documentFileStore, metadataStore, directory }, id("b"), "boundary");
    metadataStore.recordDocumentAccess(id("b"), DAY + 1);
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => DAY * 31 + 1,
    });

    const result = await cleanup.clean();
    assert.equal(result.removedDocuments, 1);
    assert.equal(metadataStore.getDocumentMetadata(id("a")), undefined);
    assert.notEqual(metadataStore.getDocumentMetadata(id("b")), undefined);
  }));

test("does not remove an active read and removes it after the stream closes", async () =>
  withEnvironment(async ({ documentFileStore, metadataStore, directory }) => {
    const documentId = id("c");
    await publishPhysical({ documentFileStore, metadataStore, directory }, documentId, "active");
    const reader = createMetadataGatedDocumentReader({ documentFileStore, metadataStore });
    const stream = await reader.readPublishedDocument(documentId);
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => DAY * 31 + 1,
    });

    const retained = await cleanup.clean();
    assert.equal(retained.removedDocuments, 0);
    assert.notEqual(metadataStore.getDocumentMetadata(documentId), undefined);
    stream.destroy();
    await new Promise((resolve) => stream.once("close", resolve));

    const removed = await cleanup.clean();
    assert.equal(removed.removedDocuments, 1);
    assert.equal(metadataStore.getDocumentMetadata(documentId), undefined);
  }));

test("cross-store active reads remain protected by a filesystem reference", async () =>
  withEnvironment(
    async ({ documentFileStore, metadataStore, directory, documentsDir, stagingDir }) => {
      const documentId = id("i");
      await publishPhysical(
        { documentFileStore, metadataStore, directory },
        documentId,
        "cross-store"
      );
      const secondStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));
      try {
        const reader = createMetadataGatedDocumentReader({
          documentFileStore,
          metadataStore,
        });
        const stream = await reader.readPublishedDocument(documentId);
        const cleanup = createDocumentCleanupCoordinator({
          documentFileStore: secondStore,
          metadataStore,
          now: () => DAY * 31 + 1,
        });
        const retained = await cleanup.clean();
        assert.equal(retained.removedDocuments, 0);
        assert.equal(retained.failures.length, 1);
        stream.resume();
        await new Promise((resolve) => stream.once("close", resolve));
        assert.equal((await cleanup.clean()).removedDocuments, 1);
      } finally {
        await secondStore.close();
      }
    }
  ));

test("cleanup handles roughly 500 expired documents and reports physical bytes", () =>
  withEnvironment(async ({ documentFileStore, metadataStore, documentsDir }) => {
    const documents = 500;
    await Promise.all(
      Array.from({ length: documents }, async (_, index) => {
        const documentId = `a${index.toString(36).padStart(20, "0")}`;
        await writeFile(join(documentsDir, `${documentId}.html`), "x");
        metadataStore.insertDocumentMetadata({
          id: documentId,
          createdAt: 1,
          lastAccessedAt: 1,
          size: 999,
        });
      })
    );
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => DAY * 31 + 1,
    });
    const result = await cleanup.clean();
    assert.equal(result.removedDocuments, documents);
    assert.equal(result.removedDocumentFiles, documents);
    assert.equal(result.removedMetadataRows, documents);
    assert.equal(result.reclaimedBytes, documents);
  }));

test("startup reconciliation removes orphan files, missing rows, mismatches, and staged snapshots", () =>
  withEnvironment(
    async ({ documentFileStore, metadataStore, documentsDir, directory, stagingDir }) => {
      const orphanId = id("d");
      const missingId = id("e");
      const mismatchId = id("f");
      await publishPhysical({ documentFileStore, metadataStore, directory }, mismatchId, "bytes");
      metadataStore.deleteDocument(mismatchId);
      await writeFile(join(documentsDir, `${orphanId}.html`), "orphan");
      const stale = new Date(DAY - V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS - 1);
      await utimes(join(documentsDir, `${orphanId}.html`), stale, stale);
      metadataStore.insertDocumentMetadata({
        id: missingId,
        createdAt: 1,
        lastAccessedAt: DAY * 2,
        size: 99,
      });
      metadataStore.insertDocumentMetadata({
        id: mismatchId,
        createdAt: 1,
        lastAccessedAt: DAY * 2,
        size: 99,
      });
      const stagedSource = join(directory, "staged.html");
      await writeFile(stagedSource, "interrupted");
      const stagedHandle = await documentFileStore.stageSourceFile(stagedSource);
      const stagedTime = new Date(DAY - V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS - 1);
      await utimes(join(stagingDir, stagedHandle), stagedTime, stagedTime);

      const cleanup = createDocumentCleanupCoordinator({
        documentFileStore,
        metadataStore,
        now: () => DAY,
      });
      const result = await cleanup.clean();

      assert.equal(result.removedDocumentFiles, 2);
      assert.equal(result.removedMetadataRows, 2);
      assert.equal(result.removedStagedFiles, 1);
      assert.deepEqual(await readdir(documentsDir), []);
      assert.deepEqual(await readdir(stagingDir), []);
    }
  ));

test("rechecks fresh and stale lock state and reports only removed locks", () =>
  withEnvironment(async ({ documentFileStore, stagingDir }) => {
    const now = DAY;
    const staleId = "j".repeat(21);
    const freshId = "k".repeat(21);
    const staleLock = join(stagingDir, `.${staleId}.target.lock`);
    const freshLock = join(stagingDir, `.${freshId}.target.lock`);
    await mkdir(staleLock);
    await writeFile(
      join(staleLock, "owner.json"),
      JSON.stringify({
        version: 1,
        owner: { pid: 99_999_999, host: hostname(), token: "stale" },
        acquiredAt: now - 20_000,
        leaseExpiresAt: now - 10_000,
      })
    );
    await mkdir(freshLock);
    await writeFile(
      join(freshLock, "owner.json"),
      JSON.stringify({
        version: 1,
        owner: { pid: process.pid, host: hostname(), token: "fresh" },
        acquiredAt: now - 100,
        leaseExpiresAt: now + 10_000,
      })
    );
    const result = await documentFileStore.reconcileDocumentFiles();
    assert.equal(result.finalizationLocksRemoved, 1);
    assert.equal(result.retainedEntries, 1);
    assert.deepEqual(await readdir(stagingDir), [`.${freshId}.target.lock`]);
  }));

test("retains a fresh uncommitted target for an in-flight publisher window", () =>
  withEnvironment(async ({ documentFileStore, metadataStore, documentsDir }) => {
    const documentId = id("h");
    await writeFile(join(documentsDir, `${documentId}.html`), "fresh target");
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => Date.now(),
    });

    const result = await cleanup.clean();
    assert.equal(result.removedDocumentFiles, 0);
    assert.equal(result.retainedEntries, 1);
    assert.equal(
      (await readFile(join(documentsDir, `${documentId}.html`))).toString(),
      "fresh target"
    );
  }));

test("faults are reported without deleting a candidate", () =>
  withEnvironment(async ({ documentFileStore, metadataStore, directory }) => {
    const documentId = id("g");
    await publishPhysical({ documentFileStore, metadataStore, directory }, documentId, "fault");
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => DAY * 31 + 1,
      beforeDocumentCleanup: async () => {
        throw new Error("injected cleanup fault");
      },
    });
    const result = await cleanup.clean();
    assert.equal(result.failures.length, 1);
    assert.notEqual(metadataStore.getDocumentMetadata(documentId), undefined);
    assert.equal(
      (await readFile(join(directory, "documents", `${documentId}.html`))).toString(),
      "fault"
    );
  }));
