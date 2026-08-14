import { parentPort, workerData } from "node:worker_threads";
import { V1_STORAGE_METADATA_BYTES_PER_DOCUMENT, V1_STORAGE_QUOTA_BYTES } from "@planview/core";
import { Effect } from "effect";
import { openStorage } from "../dist/index.js";

let storage;
try {
  storage = Effect.runSync(openStorage(workerData.databasePath));
  storage.insertDocumentMetadata({
    id: workerData.id,
    createdAt: 1,
    lastAccessedAt: 1,
    size: V1_STORAGE_QUOTA_BYTES - V1_STORAGE_METADATA_BYTES_PER_DOCUMENT,
  });
  parentPort.postMessage("accepted");
} catch (error) {
  parentPort.postMessage(error?._tag === "StorageQuotaExceededError" ? "quota" : "error");
} finally {
  storage?.close();
}
