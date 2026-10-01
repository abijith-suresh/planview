import { UTFile } from "uploadthing/server";

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

export function createUploadThingStorageAdapter(
  api: UploadThingStorageApi
): DocumentStorageAdapter {
  const getUploadLocator = (objectId: string): StoredDocument => ({
    storageProvider: "uploadthing",
    storageKey: `${customIdPrefix}${objectId}`,
  });
  return {
    provider: "uploadthing",
    getUploadLocator,
    async upload({ file, objectId }: DocumentStorageUpload): Promise<StoredDocument> {
      const result = await api.uploadFiles(
        new UTFile([new Uint8Array(await file.arrayBuffer())], file.name, {
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
      const result = await api.getFileUrls(locator.key, { keyType: locator.keyType });
      const file = result.data[0];
      if (!file) throw new Error("The uploaded file could not be found.");
      return file.url;
    },
    async delete(key) {
      const locator = locatorFor(key);
      const result = await api.deleteFiles(locator.key, { keyType: locator.keyType });
      if (!result.success) throw new Error("UploadThing could not delete the stored document.");
    },
  };
}
