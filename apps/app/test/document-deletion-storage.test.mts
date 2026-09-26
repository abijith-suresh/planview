import assert from "node:assert/strict";
import { test } from "node:test";

import { deleteUploadThingFile } from "../convex/document-deletion-storage.ts";

const customKey = "uploadthing-custom-id:owner_123:document_123";

test("deletes a custom-ID file without an existence round trip", async () => {
  const calls: string[] = [];
  await deleteUploadThingFile(
    {
      deleteFiles: async (key, options) => {
        calls.push(`${options.keyType}:${key}`);
        return { success: true };
      },
      getFileUrls: async () => {
        throw new Error("unexpected lookup");
      },
    },
    customKey
  );
  assert.deepEqual(calls, ["customId:owner_123:document_123"]);
});

test("treats an already removed legacy file as complete after a failed delete", async () => {
  const calls: string[] = [];
  await deleteUploadThingFile(
    {
      deleteFiles: async (key, options) => {
        calls.push(`${options.keyType}:${key}`);
        throw new Error("request timed out after deletion");
      },
      getFileUrls: async (key, options) => {
        calls.push(`${options.keyType}:${key}`);
        return { data: [] };
      },
    },
    "legacy-file-key"
  );
  assert.deepEqual(calls, ["fileKey:legacy-file-key", "fileKey:legacy-file-key"]);
});

test("keeps a job pending when UploadThing still has the object", async () => {
  await assert.rejects(
    deleteUploadThingFile(
      {
        deleteFiles: async () => ({ success: false }),
        getFileUrls: async () => ({ data: [{ url: "https://example.com/file" }] }),
      },
      customKey
    ),
    /could not delete/
  );
});

test("keeps a job pending when UploadThing cannot confirm absence", async () => {
  await assert.rejects(
    deleteUploadThingFile(
      {
        deleteFiles: async () => {
          throw new Error("temporary failure");
        },
        getFileUrls: async () => {
          throw new Error("lookup unavailable");
        },
      },
      customKey
    ),
    /lookup unavailable/
  );
});
