import { createUploadThingStorage } from "./document-storage-uploadthing.ts";

export { createUploadThingStorageAdapter } from "./document-storage-uploadthing.ts";

export const documentStorageProviders = ["uploadthing"] as const;
export type DocumentStorageProvider = (typeof documentStorageProviders)[number];

export type StoredDocument = {
  storageProvider: DocumentStorageProvider;
  storageKey: string;
};

export type DocumentStorageUpload = { file: File; objectId: string; deadlineAt: number };

export interface DocumentStorageAdapter {
  readonly provider: DocumentStorageProvider;
  getUploadLocator(objectId: string): StoredDocument;
  upload(input: DocumentStorageUpload): Promise<StoredDocument>;
  getReadUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

export function isDocumentStorageConfigured() {
  return Boolean(process.env["UPLOADTHING_TOKEN"]);
}

export function getDocumentStorage(provider = "uploadthing"): DocumentStorageAdapter {
  if (provider !== "uploadthing") {
    throw new Error(`Unsupported document storage provider: ${provider}`);
  }

  const token = process.env["UPLOADTHING_TOKEN"];
  if (!token) throw new Error("UploadThing is not configured");

  return createUploadThingStorage(token);
}
