import { parentPort, workerData } from "node:worker_threads";
import { V1_STORAGE_METADATA_BYTES_PER_DOCUMENT, V1_STORAGE_QUOTA_BYTES } from "@planview/core";
import { Effect } from "effect";
import { openStorage, StorageQuotaExceededError } from "../dist/index.js";

if (parentPort === null) {
  throw new Error("The quota insert worker requires a parent port.");
}
const port = parentPort;

const { databasePath, id } = workerData as {
  readonly databasePath: string;
  readonly id: string;
};
let storage;
try {
  storage = Effect.runSync(openStorage(databasePath));
  storage.insertDocumentMetadata({
    id,
    createdAt: 1,
    lastAccessedAt: 1,
    size: V1_STORAGE_QUOTA_BYTES - V1_STORAGE_METADATA_BYTES_PER_DOCUMENT,
  });
  port.postMessage("accepted");
} catch (error) {
  port.postMessage(error instanceof StorageQuotaExceededError ? "quota" : "error");
} finally {
  storage?.close();
}
