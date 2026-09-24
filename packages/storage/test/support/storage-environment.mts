import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { openDocumentFileStore, openStorage } from "../../dist/index.js";
import type {
  DocumentFileStore,
  DocumentFileStoreOptions,
  MetadataStore,
} from "../../dist/index.js";

export type StorageTestEnvironment = Readonly<{
  readonly directory: string;
  readonly documentsDir: string;
  readonly stagingDir: string;
  readonly documentFileStore: DocumentFileStore;
  readonly metadataStore: MetadataStore;
}>;

export type StorageTestStoreOptions = Omit<DocumentFileStoreOptions, "documentsDir" | "stagingDir">;

export const withStorageTestEnvironment = async <T,>(
  prefix: string,
  callback: (environment: StorageTestEnvironment) => T | PromiseLike<T>,
  storeOptions: StorageTestStoreOptions = {}
): Promise<T> => {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const documentsDir = join(directory, "documents");
  const stagingDir = join(directory, "staging");
  let documentFileStore: DocumentFileStore | undefined;
  let metadataStore: MetadataStore | undefined;
  let result: T | undefined;
  let operationFailed = false;
  let operationError: unknown;

  try {
    documentFileStore = Effect.runSync(
      openDocumentFileStore({ documentsDir, stagingDir, ...storeOptions })
    );
    metadataStore = Effect.runSync(openStorage(join(directory, "metadata.sqlite")));
    result = await callback({
      directory,
      documentsDir,
      stagingDir,
      documentFileStore,
      metadataStore,
    });
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (documentFileStore !== undefined) {
    try {
      await documentFileStore.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (metadataStore !== undefined) {
    try {
      metadataStore.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (operationFailed && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Storage test environment operation and cleanup failed."
    );
  }
  if (operationFailed) {
    throw operationError;
  }
  if (cleanupErrors.length === 1) {
    throw cleanupErrors[0];
  }
  if (cleanupErrors.length > 1) {
    throw new AggregateError(cleanupErrors, "Storage test environment cleanup failed.");
  }

  return result as T;
};
