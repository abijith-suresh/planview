import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Effect } from "effect";
import {
  createDocumentCleanupCoordinator,
  createDocumentPublicationCoordinator,
  createMetadataGatedDocumentReader,
  openDocumentFileStore,
  openStorage,
  V1_CLEANUP_ITEM_BUDGET,
  V1_ORPHAN_RECONCILIATION_GRACE_MILLISECONDS,
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

test("a read lease remains active after full transfer until its post-transfer work releases it", async () =>
  withEnvironment(async ({ documentFileStore, metadataStore, directory }) => {
    const documentId = id("l");
    await publishPhysical({ documentFileStore, metadataStore, directory }, documentId, "leased");
    const lease = await documentFileStore.readDocumentLease(documentId);
    assert.equal((await lease.stream.toArray()).toString(), "leased");

    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => DAY * 31 + 1,
    });
    const retained = await cleanup.clean();
    assert.equal(retained.removedDocuments, 0);
    assert.notEqual(metadataStore.getDocumentMetadata(documentId), undefined);

    lease.release();
    const removed = await cleanup.clean();
    assert.equal(removed.removedDocuments, 1);
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
    const totals = {
      removedDocuments: 0,
      removedDocumentFiles: 0,
      removedMetadataRows: 0,
      reclaimedBytes: 0,
    };
    let result;
    do {
      result = await cleanup.clean();
      for (const field of Object.keys(totals)) {
        totals[field] += result[field];
      }
    } while (result.resumable);
    assert.equal(totals.removedDocuments, documents);
    assert.equal(totals.removedDocumentFiles, documents);
    assert.equal(totals.removedMetadataRows, documents);
    assert.equal(totals.reclaimedBytes, documents);
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

test("reconciles read markers left by a crashed local reader", () =>
  withEnvironment(async ({ documentFileStore, stagingDir }) => {
    const documentId = id("r");
    const token = "a".repeat(22);
    const marker = join(stagingDir, `.read.${documentId}.${token}`);
    await writeFile(
      marker,
      JSON.stringify({
        version: 1,
        owner: { pid: 99_999_999, host: hostname() },
        acquiredAt: DAY,
      })
    );

    const result = await documentFileStore.reconcileDocumentFiles();
    assert.equal(result.readReferencesRemoved, 1);
    assert.equal(result.retainedEntries, 0);
    assert.deepEqual(await readdir(stagingDir), []);
  }));

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
  withEnvironment(
    async ({ documentFileStore, metadataStore, documentsDir }) => {
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
    },
    { documentFileScanStartedAt: () => Number.MAX_SAFE_INTEGER }
  ));

test("cleanup cannot delete a hard-linked target while publication commits metadata", () => {
  let cleanup;
  let publication;
  let publicationPromise;
  let targetLinkReadyResolve;
  const targetLinkReady = new Promise((resolve) => {
    targetLinkReadyResolve = resolve;
  });
  let releaseTargetLink;
  const targetLinkRelease = new Promise((resolve) => {
    releaseTargetLink = resolve;
  });
  let sizeEnteredResolve;
  const sizeEntered = new Promise((resolve) => {
    sizeEnteredResolve = resolve;
  });
  let releaseSize;
  const sizeRelease = new Promise((resolve) => {
    releaseSize = resolve;
  });
  return withEnvironment(
    async ({ documentFileStore, metadataStore, directory, documentsDir }) => {
      const documentId = id("p");
      const source = join(directory, "publishing.html");
      await writeFile(source, "publication fence");
      cleanup = createDocumentCleanupCoordinator({
        documentFileStore,
        metadataStore,
        now: () => 1_700_000_000_000,
      });
      publication = createDocumentPublicationCoordinator({
        documentFileStore,
        metadataStore,
        generateId: () => documentId,
        now: () => 1_700_000_000_000,
        readPublishedSize: async () => {
          sizeEnteredResolve();
          await sizeRelease;
          return 17;
        },
      });

      publicationPromise = publication.publish(source);
      await targetLinkReady;
      const cleanupRun = cleanup.clean();
      const cleanupResult = await cleanupRun;
      releaseSize();
      const result = await publicationPromise;

      assert.equal(result.id, documentId);
      assert.equal(cleanupResult.removedDocumentFiles, 0);
      assert.equal(cleanupResult.removedMetadataRows, 0);
      assert.equal(cleanupResult.failures.length, 1);
      assert.deepEqual(metadataStore.getDocumentMetadata(documentId), result.metadata);
      assert.equal(
        (await readFile(join(documentsDir, `${documentId}.html`))).toString(),
        "publication fence"
      );
    },
    {
      documentFileScanStartedAt: () => Number.MAX_SAFE_INTEGER,
      documentFileScanObservation: (observation) => ({
        ...observation,
        modifiedAt: 1,
      }),
      beforeDocumentFilePageScan: async () => {
        releaseTargetLink();
        await sizeEntered;
      },
      beforeFinalizationTargetLink: async () => {
        targetLinkReadyResolve();
        await targetLinkRelease;
      },
    }
  );
});

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
    assert.equal(result.resumable, false);
    assert.notEqual(metadataStore.getDocumentMetadata(documentId), undefined);
    assert.equal(
      (await readFile(join(directory, "documents", `${documentId}.html`))).toString(),
      "fault"
    );
  }));

test("canceled cleanup returns a resumable cursor without skipping the active row", () =>
  withEnvironment(async ({ documentFileStore, metadataStore, directory }) => {
    const documentId = id("n");
    await publishPhysical({ documentFileStore, metadataStore, directory }, documentId, "resume");
    const controller = new AbortController();
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => DAY * 31 + 1,
      beforeDocumentCleanup: async () => {
        controller.abort(new Error("cleanup canceled"));
      },
    });

    const canceled = await cleanup.clean(controller.signal);
    assert.equal(canceled.resumable, true);
    assert.equal(canceled.removedDocuments, 0);
    assert.notEqual(metadataStore.getDocumentMetadata(documentId), undefined);

    const resumed = await cleanup.clean();
    assert.equal(resumed.removedDocuments, 1);
    assert.equal(metadataStore.getDocumentMetadata(documentId), undefined);
    assert.deepEqual(await readdir(join(directory, "documents")), []);
  }));

test("pages document files in exact bytewise order and resume without gaps", () => {
  const ids = [id("A"), id("_"), id("-"), id("a"), id("0")];
  const insertedId = id("1");
  return withEnvironment(
    async ({ documentFileStore, documentsDir }) => {
      await Promise.all(
        ids.map((documentId) => writeFile(join(documentsDir, `${documentId}.html`), "x"))
      );
      const expected = [...ids].sort((left, right) =>
        Buffer.compare(Buffer.from(left), Buffer.from(right))
      );
      const observed = [];
      let page = await documentFileStore.listDocumentFilesPage(2);
      const watermark = page.watermark;
      observed.push(...page.files.map((file) => file.id));
      await writeFile(join(documentsDir, `${insertedId}.html`), "new");
      let after = page.nextId;
      do {
        page = await documentFileStore.listDocumentFilesPage(2, after, watermark);
        observed.push(...page.files.map((file) => file.id));
        after = page.nextId;
      } while (page.hasMore);
      assert.deepEqual(observed, expected);
    },
    {
      documentFileScanStartedAt: () => 100,
      documentFileScanObservation: (observation) => ({
        ...observation,
        identity: {
          ...observation.identity,
          birthtimeMs: observation.id === insertedId ? 200 : 1,
        },
      }),
    }
  );
});

test("defers a post-start file with a coarse birth-time fence without skipping", () => {
  const firstId = id("a");
  const candidateId = id("b");
  const upperId = id("z");
  let documentsDirectory;
  let inserted = false;
  return withEnvironment(
    async ({ documentFileStore, documentsDir }) => {
      documentsDirectory = documentsDir;
      await Promise.all([
        writeFile(join(documentsDir, `${firstId}.html`), "existing"),
        writeFile(join(documentsDir, `${upperId}.html`), "upper"),
      ]);

      const first = await documentFileStore.listDocumentFilesPage(1);
      assert.deepEqual(
        first.files.map((file) => file.id),
        [firstId]
      );
      assert.equal(first.nextId, firstId);
      assert.equal(first.watermark?.startedAt, 200);

      const deferred = await documentFileStore.listDocumentFilesPage(
        1,
        first.nextId,
        first.watermark
      );
      assert.deepEqual(deferred.files, []);
      assert.equal(deferred.nextId, candidateId);
      assert.equal(deferred.hasMore, true);

      const resumed = await documentFileStore.listDocumentFilesPage(
        1,
        deferred.nextId,
        first.watermark
      );
      assert.deepEqual(
        resumed.files.map((file) => file.id),
        [upperId]
      );
    },
    {
      documentFileScanStartedAt: () => 200,
      beforeDocumentFilePageScan: async (startedAt) => {
        assert.equal(startedAt, 200);
        if (!inserted) {
          inserted = true;
          await writeFile(join(documentsDirectory, `${candidateId}.html`), "post-start");
        }
      },
      documentFileScanObservation: (observation) => ({
        ...observation,
        identity: {
          ...observation.identity,
          birthtimeMs: observation.id === candidateId ? 200 : 100,
        },
      }),
    }
  );
});

test("defers entries whose birth time is unavailable", () =>
  withEnvironment(
    async ({ documentFileStore, documentsDir }) => {
      const firstId = id("a");
      const deferredId = id("b");
      await writeFile(join(documentsDir, `${firstId}.html`), "existing");
      await writeFile(join(documentsDir, `${deferredId}.html`), "unavailable");
      const page = await documentFileStore.listDocumentFilesPage(2);
      assert.deepEqual(page.files, []);
      assert.equal(page.nextId, deferredId);
    },
    {
      documentFileScanStartedAt: () => 200,
      documentFileScanObservation: (observation) => ({
        ...observation,
        identity: {
          ...observation.identity,
          birthtimeMs: Number.NaN,
        },
      }),
    }
  ));

test("does not remove a replacement scan marker", () =>
  withEnvironment(
    async ({ documentFileStore, documentsDir }) => {
      await assert.rejects(documentFileStore.listDocumentFilesPage(1), /identity-safe discard/);
      const entries = await readdir(documentsDir);
      assert.equal(entries.filter((entry) => entry.startsWith(".scan-")).length, 1);
    },
    {
      documentFileScanStartedAt: () => 100,
      beforeDocumentFileScanMarkerCleanup: async (markerPath) => {
        await rm(markerPath);
        await writeFile(markerPath, "replacement marker");
      },
    }
  ));

test("keeps reconciliation inside the cleanup item budget", () =>
  withEnvironment(async ({ documentFileStore, stagingDir }) => {
    const entries = V1_CLEANUP_ITEM_BUDGET + 96;
    for (let index = 0; index < entries; index += 1) {
      const handle = `${index.toString(36).padStart(42, "0")}a`;
      const stagedPath = join(stagingDir, handle);
      await writeFile(stagedPath, "stale");
      await utimes(stagedPath, new Date(1), new Date(1));
    }
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore: {
        getDocumentMetadataScanWatermark: () => 0,
        listDocumentMetadataCandidates: () => ({ rows: [], hasMore: false }),
        listDocumentMetadataPage: () => ({ rows: [], hasMore: false }),
      },
      now: () => Date.now() + DAY,
    });
    const first = await cleanup.clean();
    assert.equal(first.processedItems <= V1_CLEANUP_ITEM_BUDGET, true);
    assert.equal(first.resumable, true);
    let result = first;
    while (result.resumable) {
      result = await cleanup.clean();
    }
    assert.deepEqual(await readdir(stagingDir), []);
  }));

test("does not delete an ABA-replaced metadata row", () =>
  withEnvironment(async ({ documentFileStore, metadataStore, directory }) => {
    const documentId = id("q");
    await publishPhysical({ documentFileStore, metadataStore, directory }, documentId, "aba");
    let replaced = false;
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => DAY * 31 + 1,
      beforeDocumentCleanup: async (candidate) => {
        if (!replaced) {
          replaced = true;
          assert.equal(metadataStore.deleteDocument(candidate), true);
          metadataStore.insertDocumentMetadata({
            id: candidate,
            createdAt: 1,
            lastAccessedAt: 1,
            size: 3,
          });
        }
      },
    });
    const first = await cleanup.clean();
    assert.equal(first.removedDocuments, 0);
    assert.notEqual(metadataStore.getDocumentMetadata(documentId), undefined);
    assert.equal(
      (await readFile(join(directory, "documents", `${documentId}.html`))).toString(),
      "aba"
    );
    assert.equal((await cleanup.clean()).removedDocuments, 1);
  }));

test("defers rows inserted during a cleanup pass to the next watermark", () =>
  withEnvironment(async ({ documentFileStore, metadataStore, directory }) => {
    const originalId = id("s");
    const insertedId = id("t");
    await publishPhysical({ documentFileStore, metadataStore, directory }, originalId, "old");
    let inserted = false;
    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => DAY * 31 + 1,
      beforeDocumentCleanup: async () => {
        if (inserted) {
          return;
        }
        inserted = true;
        await writeFile(join(directory, "documents", `${insertedId}.html`), "new");
        metadataStore.insertDocumentMetadata({
          id: insertedId,
          createdAt: 1,
          lastAccessedAt: 1,
          size: 3,
        });
      },
    });
    await cleanup.clean();
    assert.notEqual(metadataStore.getDocumentMetadata(insertedId), undefined);
    assert.equal((await cleanup.clean()).removedDocuments, 1);
    assert.equal(metadataStore.getDocumentMetadata(insertedId), undefined);
  }));
