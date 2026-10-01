import assert from "node:assert/strict";
import { test } from "node:test";

import { createUploadThingStorageAdapter } from "../src/lib/document-storage.ts";

test("passes custom IDs to UploadThing and accepts an idempotent zero-count deletion", async () => {
  const calls: Array<{ key: string; keyType: string }> = [];
  const adapter = createUploadThingStorageAdapter({
    uploadFiles: async () => ({ data: {}, error: null }),
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
    uploadFiles: async () => ({ data: {}, error: null }),
    getFileUrls: async () => ({ data: [] }),
    deleteFiles: async () => ({ success: false, deletedCount: 0 }),
  });

  await assert.rejects(
    adapter.delete("uploadthing-custom-id:owner_123:uuid-123"),
    /UploadThing could not delete the stored document/
  );
});

test("upload owns provider-specific options and returns its locator", async () => {
  const adapter = createUploadThingStorageAdapter({
    uploadFiles: async (file, options) => {
      assert.equal(file.customId, "owner_123:object-456");
      assert.equal(file.type, "text/html");
      assert.equal(file.name, "plan.html");
      assert.equal(await file.text(), "<h1>Plan</h1>");
      assert.deepEqual(options, { acl: "public-read", contentDisposition: "inline" });
      return { data: { key: "provider-result" }, error: null };
    },
    getFileUrls: async () => ({ data: [] }),
    deleteFiles: async () => ({ success: true, deletedCount: 1 }),
  });
  assert.deepEqual(
    await adapter.upload({
      file: new File(["<h1>Plan</h1>"], "plan.html"),
      objectId: "owner_123:object-456",
    }),
    {
      storageProvider: "uploadthing",
      storageKey: "uploadthing-custom-id:owner_123:object-456",
    }
  );
});

test("reads both custom locators and older raw file keys", async () => {
  const calls: string[] = [];
  const adapter = createUploadThingStorageAdapter({
    uploadFiles: async () => ({ data: {}, error: null }),
    getFileUrls: async (key, options) => {
      calls.push(`${options.keyType}:${key}`);
      return { data: [{ url: "https://cdn.example/read" }] };
    },
    deleteFiles: async () => ({ success: true, deletedCount: 1 }),
  });
  assert.equal(
    await adapter.getReadUrl("uploadthing-custom-id:owner:object"),
    "https://cdn.example/read"
  );
  assert.equal(await adapter.getReadUrl("legacy-key"), "https://cdn.example/read");
  assert.deepEqual(calls, ["customId:owner:object", "fileKey:legacy-key"]);
});

test("upload failure never returns a locator", async () => {
  const adapter = createUploadThingStorageAdapter({
    uploadFiles: async () => ({ data: null, error: { message: "provider upload failed" } }),
    getFileUrls: async () => ({ data: [] }),
    deleteFiles: async () => ({ success: true, deletedCount: 1 }),
  });
  await assert.rejects(
    adapter.upload({ file: new File(["plan"], "plan.html"), objectId: "owner:object" }),
    /provider upload failed/
  );
});
