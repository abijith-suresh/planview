import { UTApi } from "uploadthing/server";

export const documentStorageProviders = ["uploadthing"] as const;
export type DocumentStorageProvider = (typeof documentStorageProviders)[number];

export interface DocumentStorageAdapter {
  readonly provider: DocumentStorageProvider;
  getReadUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

class UploadThingStorageAdapter implements DocumentStorageAdapter {
  readonly provider = "uploadthing" as const;

  constructor(private readonly api: UTApi) {}

  async getReadUrl(key: string) {
    const result = await this.api.getFileUrls(key);
    const file = result.data[0];

    if (!file) {
      throw new Error("The uploaded file could not be found.");
    }

    return file.url;
  }

  async delete(key: string) {
    await this.api.deleteFiles(key);
  }
}

export function isDocumentStorageConfigured() {
  return Boolean(process.env.UPLOADTHING_TOKEN);
}

export function getDocumentStorage(provider: string): DocumentStorageAdapter {
  if (provider !== "uploadthing") {
    throw new Error(`Unsupported document storage provider: ${provider}`);
  }

  const token = process.env.UPLOADTHING_TOKEN;

  if (!token) {
    throw new Error("UploadThing is not configured");
  }

  return new UploadThingStorageAdapter(new UTApi({ token }));
}
