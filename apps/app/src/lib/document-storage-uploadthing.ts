import { UTApi, UTFile } from "uploadthing/server";

import type {
  DocumentStorageAdapter,
  DocumentStorageUpload,
  StoredDocument,
} from "./document-storage.ts";

type UploadThingStorageApi = {
  uploadFiles(
    file: UTFile,
    options: { acl: "public-read"; contentDisposition: "inline" }
  ): Promise<{ data: unknown; error: { message: string } | null }>;
  getFileUrls(
    key: string,
    options: { keyType: "fileKey" | "customId" }
  ): Promise<{ data: readonly { url: string }[] }>;
  deleteFiles(
    key: string,
    options: { keyType: "fileKey" | "customId" }
  ): Promise<{ success: boolean; deletedCount: number }>;
};

const customIdPrefix = "uploadthing-custom-id:";

function locatorFor(key: string) {
  if (key.startsWith(customIdPrefix)) {
    return { key: key.slice(customIdPrefix.length), keyType: "customId" as const };
  }
  // Records created before provider locators contain raw UploadThing file keys.
  return { key, keyType: "fileKey" as const };
}

function remainingUploadTime(deadlineAt: number): number {
  const remainingMs = deadlineAt - Date.now();
  if (!Number.isSafeInteger(deadlineAt) || remainingMs <= 0) {
    throw new Error("The upload reservation expired. Try uploading again.");
  }
  return remainingMs;
}

export function createUploadThingStorageAdapter(
  source: UploadThingStorageApi | ((deadlineAt?: number) => UploadThingStorageApi)
): DocumentStorageAdapter {
  const getApi = (deadlineAt?: number) =>
    typeof source === "function" ? source(deadlineAt) : source;
  const getUploadLocator = (objectId: string): StoredDocument => ({
    storageProvider: "uploadthing",
    storageKey: `${customIdPrefix}${objectId}`,
  });
  return {
    provider: "uploadthing",
    getUploadLocator,
    async upload({ file, objectId, deadlineAt }: DocumentStorageUpload): Promise<StoredDocument> {
      remainingUploadTime(deadlineAt);
      const bytes = new Uint8Array(await file.arrayBuffer());
      // Preparing the file must not restart or outlive the absolute reservation deadline.
      remainingUploadTime(deadlineAt);
      const result = await getApi(deadlineAt).uploadFiles(
        new UTFile([bytes], file.name, {
          type: "text/html",
          customId: objectId,
        }),
        { acl: "public-read", contentDisposition: "inline" }
      );
      if (result.error || !result.data) {
        throw new Error(result.error?.message ?? "The HTML file could not be stored.");
      }
      return getUploadLocator(objectId);
    },
    async getReadUrl(key) {
      const locator = locatorFor(key);
      const result = await getApi().getFileUrls(locator.key, { keyType: locator.keyType });
      const file = result.data[0];
      if (!file) throw new Error("The uploaded file could not be found.");
      return file.url;
    },
    async delete(key) {
      const locator = locatorFor(key);
      const result = await getApi().deleteFiles(locator.key, { keyType: locator.keyType });
      if (!result.success) throw new Error("UploadThing could not delete the stored document.");
    },
  };
}

export function createUploadDeadlineSignal(deadlineAt: number): AbortSignal {
  return AbortSignal.timeout(remainingUploadTime(deadlineAt));
}

type UploadThingFetch = NonNullable<NonNullable<ConstructorParameters<typeof UTApi>[0]>["fetch"]>;

export function createUploadThingUploadFetch(
  deadlineAt: number,
  fetchImplementation: typeof fetch = fetch
): UploadThingFetch {
  const signal = createUploadDeadlineSignal(deadlineAt);
  return (input, init) => {
    remainingUploadTime(deadlineAt);
    return fetchImplementation(input, {
      ...init,
      signal:
        init && "signal" in init && init.signal instanceof AbortSignal
          ? AbortSignal.any([signal, init.signal])
          : signal,
    });
  };
}

export function createUploadThingStorage(token: string): DocumentStorageAdapter {
  return createUploadThingStorageAdapter(
    (deadlineAt) =>
      new UTApi({
        token,
        ...(deadlineAt === undefined ? {} : { fetch: createUploadThingUploadFetch(deadlineAt) }),
      })
  );
}
