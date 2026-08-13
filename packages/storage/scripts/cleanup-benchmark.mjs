import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import {
  createDocumentCleanupCoordinator,
  openDocumentFileStore,
  openStorage,
} from "../dist/index.js";

const DAY = 24 * 60 * 60 * 1_000;
const now = Date.now() + 31 * DAY;

const memory = () => {
  const usage = process.memoryUsage();
  return {
    rss: usage.rss,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
  };
};

const documentIdFor = (index) => `b${index.toString(36).padStart(20, "0")}`;

const runProbe = async (count) => {
  const directory = await mkdtemp(join(tmpdir(), "planview-cleanup-benchmark-"));
  const documentsDir = join(directory, "documents");
  const stagingDir = join(directory, "staging");
  const databasePath = join(directory, "metadata.sqlite");
  const metadataStore = Effect.runSync(openStorage(databasePath));
  const documentFileStore = Effect.runSync(openDocumentFileStore({ documentsDir, stagingDir }));

  try {
    for (let index = 0; index < count; index += 1) {
      const id = documentIdFor(index);
      await writeFile(join(documentsDir, `${id}.html`), "x");
      metadataStore.insertDocumentMetadata({
        id,
        createdAt: 1,
        lastAccessedAt: 1,
        size: 1,
      });
    }

    const cleanup = createDocumentCleanupCoordinator({
      documentFileStore,
      metadataStore,
      now: () => now,
    });
    const before = memory();
    let peak = before;
    const startedAt = performance.now();
    let batches = 0;
    let processedItems = 0;
    let removedDocuments = 0;
    let removedDocumentFiles = 0;
    let reclaimedBytes = 0;
    let result;
    do {
      result = await cleanup.clean();
      batches += 1;
      processedItems += result.processedItems;
      removedDocuments += result.removedDocuments;
      removedDocumentFiles += result.removedDocumentFiles;
      reclaimedBytes += result.reclaimedBytes;
      const current = memory();
      peak = {
        rss: Math.max(peak.rss, current.rss),
        heapUsed: Math.max(peak.heapUsed, current.heapUsed),
        external: Math.max(peak.external, current.external),
        arrayBuffers: Math.max(peak.arrayBuffers, current.arrayBuffers),
      };
    } while (result.resumable);
    const elapsed = performance.now() - startedAt;
    const after = memory();
    const database = new DatabaseSync(databasePath);
    try {
      const generationRows = database
        .prepare("SELECT COUNT(*) AS count FROM document_generations")
        .get().count;
      if (generationRows !== 0) {
        throw new Error(`document_generations retained ${generationRows} rows after cleanup`);
      }
      process.stdout.write(
        `${JSON.stringify({
          count,
          batches,
          processedItems,
          removedDocuments,
          removedDocumentFiles,
          reclaimedBytes,
          milliseconds: Number(elapsed.toFixed(2)),
          rss: { before: before.rss, peak: peak.rss, after: after.rss },
          heapUsed: { before: before.heapUsed, peak: peak.heapUsed, after: after.heapUsed },
          external: { before: before.external, peak: peak.external, after: after.external },
        })}\n`
      );
    } finally {
      database.close();
    }
  } finally {
    await documentFileStore.close();
    metadataStore.close();
    await rm(directory, { recursive: true, force: true });
  }
};

for (const count of [1_000, 10_000]) {
  await runProbe(count);
}
