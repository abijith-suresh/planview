import { UTApi } from "uploadthing/server";

export const documentStorageProviders = ["uploadthing"] as const;
export type DocumentStorageProvider = (typeof documentStorageProviders)[number];

export interface DocumentStorageAdapter {
  readonly provider: DocumentStorageProvider;
  getReadUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

type UploadThingStorageApi = {
  getFileUrls(
    key: string,
    options: { keyType: "fileKey" | "customId" }
  ): Promise<{ data: readonly { url: string }[] }>;
  deleteFiles(
    key: string,
    options: { keyType: "fileKey" | "customId" }
  ): Promise<{ success: boolean; deletedCount: number }>;
};

const uploadThingCustomIdPrefix = "uploadthing-custom-id:";

function getUploadThingLocator(key: string) {
  if (key.startsWith(uploadThingCustomIdPrefix)) {
    return {
      key: key.slice(uploadThingCustomIdPrefix.length),
      keyType: "customId" as const,
    };
  }

  // Documents created before the provider locator was introduced stored the
  // raw UploadThing file key. Keep those records readable and deletable.
  return { key, keyType: "fileKey" as const };
}

class UploadThingStorageAdapter implements DocumentStorageAdapter {
  readonly provider = "uploadthing" as const;
  private readonly api: UploadThingStorageApi;

  constructor(api: UploadThingStorageApi) {
    this.api = api;
  }

  async getReadUrl(key: string) {
    const locator = getUploadThingLocator(key);
    const result = await this.api.getFileUrls(locator.key, { keyType: locator.keyType });
    const file = result.data[0];

    if (!file) {
      throw new Error("The uploaded file could not be found.");
    }

    return file.url;
  }

  async delete(key: string) {
    const locator = getUploadThingLocator(key);
    const result = await this.api.deleteFiles(locator.key, { keyType: locator.keyType });

    if (!result.success) {
      throw new Error("UploadThing could not delete the stored document.");
    }
  }
}

export function createUploadThingStorageAdapter(api: UploadThingStorageApi) {
  return new UploadThingStorageAdapter(api);
}

export function isDocumentStorageConfigured() {
  return Boolean(process.env["UPLOADTHING_TOKEN"]);
}

export function getDocumentStorage(provider: string): DocumentStorageAdapter {
  if (provider !== "uploadthing") {
    throw new Error(`Unsupported document storage provider: ${provider}`);
  }

  const token = process.env["UPLOADTHING_TOKEN"];

  if (!token) {
    throw new Error("UploadThing is not configured");
  }

  return createUploadThingStorageAdapter(new UTApi({ token }));
}
