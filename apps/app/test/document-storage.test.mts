import assert from "node:assert/strict";
import { test } from "node:test";

import { createUploadThingStorageAdapter } from "../src/lib/document-storage.ts";

test("passes custom IDs to UploadThing and accepts an idempotent zero-count deletion", async () => {
  const calls: Array<{ key: string; keyType: string }> = [];
  const adapter = createUploadThingStorageAdapter({
    getFileUrls: async () => ({ data: [] }),
    deleteFiles: async (key, options) => {
      calls.push({ key, keyType: options.keyType });
      return { success: true, deletedCount: 0 };
    },
  });

  await adapter.delete("uploadthing-custom-id:owner_123:uuid-123");

  assert.deepEqual(calls, [{ key: "owner_123:uuid-123", keyType: "customId" }]);
});

test("throws when UploadThing resolves a deletion as unsuccessful", async () => {
  const adapter = createUploadThingStorageAdapter({
    getFileUrls: async () => ({ data: [] }),
    deleteFiles: async () => ({ success: false, deletedCount: 0 }),
  });

  await assert.rejects(
    adapter.delete("uploadthing-custom-id:owner_123:uuid-123"),
    /UploadThing could not delete the stored document/
  );
});
