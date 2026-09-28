type Locator = { keyType: "customId" | "fileKey"; key: string };

type DeletionStorageApi = {
  deleteFiles(key: string, options: { keyType: Locator["keyType"] }): Promise<{ success: boolean }>;
  getFileUrls(
    key: string,
    options: { keyType: Locator["keyType"] }
  ): Promise<{ data: readonly unknown[] }>;
};

const customIdPrefix = "uploadthing-custom-id:";

const locatorFor = (storageKey: string): Locator =>
  storageKey.startsWith(customIdPrefix)
    ? { key: storageKey.slice(customIdPrefix.length), keyType: "customId" }
    : { key: storageKey, keyType: "fileKey" };

export const deleteUploadThingFile = async (api: DeletionStorageApi, storageKey: string) => {
  const locator = locatorFor(storageKey);
  let deletionError: unknown;
  try {
    const result = await api.deleteFiles(locator.key, { keyType: locator.keyType });
    if (result.success) return;
    deletionError = new Error("UploadThing could not delete the stored document");
  } catch (error) {
    deletionError = error;
  }

  // A prior attempt may have removed the object before Convex recorded success.
  // Only finish when UploadThing confirms the locator has no file.
  const remaining = await api.getFileUrls(locator.key, { keyType: locator.keyType });
  if (remaining.data.length === 0) return;
  throw deletionError;
};
