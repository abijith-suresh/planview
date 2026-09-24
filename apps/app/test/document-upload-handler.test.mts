import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDocumentUploadHandler,
  type DocumentUploadHandlerDependencies,
  type DocumentUploadMetadata,
} from "../src/lib/document-upload-handler.ts";

type TestClient = object;

const uploadRequestSizeLimit = 8 * 1024 * 1024 + 64 * 1024;

function createHandler(overrides: Partial<DocumentUploadHandlerDependencies<TestClient>> = {}) {
  const calls = {
    getCurrentUser: 0,
    uploads: [] as { customId: string; fileName: string }[],
    metadata: [] as DocumentUploadMetadata[],
    deletedKeys: [] as string[],
  };
  const handler = createDocumentUploadHandler<TestClient>({
    getAuthedClient: async () => ({ client: {}, token: "convex-token" }),
    getCurrentUser: async () => {
      calls.getCurrentUser += 1;
      return { subject: "owner_123" };
    },
    isStorageConfigured: () => true,
    uploadFile: async ({ file, customId }) => {
      calls.uploads.push({ customId, fileName: file.name });
    },
    createMetadata: async (_client, input) => {
      calls.metadata.push(input);
      return "document_123";
    },
    deleteStorageObject: async (key) => {
      calls.deletedKeys.push(key);
    },
    createUploadId: () => "uuid-123",
    missingServerConfigurationResponse: () =>
      Response.json({ error: "backend unavailable" }, { status: 503 }),
    errorResponse: (error) =>
      Response.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 }),
    ...overrides,
  });

  return { calls, handler };
}

function createUploadRequest(
  options: { title?: string; files?: File[]; contentLength?: string | null } = {}
) {
  const form = new FormData();
  form.set("title", options.title ?? "My document");
  for (const file of options.files ?? [
    new File(["<h1>hello</h1>"], "hello.html", { type: "text/html" }),
  ]) {
    form.append("file", file);
  }

  const init: RequestInit = {
    method: "POST",
    body: form,
    ...(options.contentLength === null
      ? {}
      : { headers: { "content-length": options.contentLength ?? "512" } }),
  };
  return new Request("http://localhost/api/documents/upload", init);
}

test("requires a bounded Content-Length before authentication or reading the body", async (t) => {
  for (const [name, contentLength, expectedStatus] of [
    ["missing", null, 411],
    ["not numeric", "not-a-number", 411],
    ["over the request limit", String(uploadRequestSizeLimit + 1), 413],
  ] as const) {
    await t.test(name, async () => {
      const { calls, handler } = createHandler({
        getAuthedClient: async () => {
          throw new Error("authentication must not run");
        },
      });
      const response = await handler({ request: createUploadRequest({ contentLength }) });

      assert.equal(response.status, expectedStatus);
      assert.equal(calls.getCurrentUser, 0);
      assert.equal(calls.uploads.length, 0);
      assert.equal(calls.metadata.length, 0);
    });
  }
});

test("rejects invalid titles, multiple files, non-HTML files, and files larger than 8 MiB", async (t) => {
  const invalidCases: Array<{ name: string; title?: string; files?: File[] }> = [
    { name: "blank title", title: "   " },
    { name: "title over 200 characters", title: "t".repeat(201) },
    {
      name: "multiple files",
      files: [
        new File(["first"], "first.html", { type: "text/html" }),
        new File(["second"], "second.html", { type: "text/html" }),
      ],
    },
    {
      name: "non-HTML extension",
      files: [new File(["<h1>hello</h1>"], "hello.txt", { type: "text/html" })],
    },
    {
      name: "non-HTML MIME type",
      files: [new File(["<h1>hello</h1>"], "hello.html", { type: "text/plain" })],
    },
    {
      name: "file larger than 8 MiB",
      files: [new File([new Uint8Array(8 * 1024 * 1024 + 1)], "large.html", { type: "text/html" })],
    },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      const { calls, handler } = createHandler();
      const response = await handler({
        request: createUploadRequest({
          title: invalidCase.title ?? "A valid title",
          ...(invalidCase.files === undefined ? {} : { files: invalidCase.files }),
        }),
      });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "Upload one .html file up to 8 MiB with a title of 1 to 200 characters",
      });
      assert.equal(calls.uploads.length, 0);
      assert.equal(calls.metadata.length, 0);
    });
  }
});

test("an unauthenticated caller cannot upload a file or create metadata", async () => {
  const { calls, handler } = createHandler({
    getAuthedClient: async () => ({ client: {}, token: null }),
  });
  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
  assert.equal(calls.getCurrentUser, 0);
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.metadata.length, 0);
});

test("stores one HTML file and binds its storage key to the authenticated owner", async () => {
  const { calls, handler } = createHandler();
  const response = await handler({
    request: createUploadRequest({ title: "  My document  " }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "document_123" });
  assert.deepEqual(calls.uploads, [{ customId: "owner_123:uuid-123", fileName: "hello.html" }]);
  assert.deepEqual(calls.metadata, [
    {
      title: "My document",
      storageProvider: "uploadthing",
      storageKey: "uploadthing-custom-id:owner_123:uuid-123",
      contentType: "text/html",
      sizeBytes: 14,
    },
  ]);
  assert.deepEqual(calls.deletedKeys, []);
});

test("does not create metadata when storing the uploaded file fails", async () => {
  let uploadAttempts = 0;
  const { calls, handler } = createHandler({
    uploadFile: async () => {
      uploadAttempts += 1;
      throw new Error("storage upload failed");
    },
  });
  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "storage upload failed" });
  assert.equal(uploadAttempts, 1);
  assert.equal(calls.metadata.length, 0);
  assert.deepEqual(calls.deletedKeys, []);
});

test("deletes the uploaded object if metadata creation fails", async () => {
  const { calls, handler } = createHandler({
    createMetadata: async () => {
      throw new Error("metadata creation failed");
    },
  });
  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "metadata creation failed" });
  assert.deepEqual(calls.uploads, [{ customId: "owner_123:uuid-123", fileName: "hello.html" }]);
  assert.deepEqual(calls.deletedKeys, ["uploadthing-custom-id:owner_123:uuid-123"]);
});

test("reports a failed compensation and keeps the metadata error response", async () => {
  const metadataCause = new Error("metadata creation failed");
  const cleanupCause = new Error("storage deletion failed");
  const reports: Array<{
    objectKey: string;
    metadataCause: unknown;
    cleanupCause: unknown;
  }> = [];
  const { calls, handler } = createHandler({
    createMetadata: async () => {
      throw metadataCause;
    },
    deleteStorageObject: async (key) => {
      calls.deletedKeys.push(key);
      throw cleanupCause;
    },
    reportCompensationFailure: async (failure) => {
      reports.push(failure);
      throw new Error("reporting failed");
    },
  });

  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "metadata creation failed" });
  assert.deepEqual(calls.deletedKeys, ["uploadthing-custom-id:owner_123:uuid-123"]);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], {
    objectKey: "uploadthing-custom-id:owner_123:uuid-123",
    metadataCause,
    cleanupCause,
  });
});

test("does not expose file storage when it is not configured", async () => {
  const { calls, handler } = createHandler({ isStorageConfigured: () => false });
  const response = await handler({ request: createUploadRequest() });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "File storage is not configured yet.",
    code: "STORAGE_NOT_CONFIGURED",
  });
  assert.equal(calls.uploads.length, 0);
  assert.equal(calls.metadata.length, 0);
});
