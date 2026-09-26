import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDocumentCollectionHandlers,
  type DocumentCollectionHandlerDependencies,
  type DocumentCollectionMetadata,
} from "../src/lib/document-collection-handlers.ts";

type TestClient = object;

const validBody = {
  title: "My document",
  storageProvider: "uploadthing",
  uploadOwnerId: "owner_123",
  uploadCustomId: "owner_123:uuid-123",
  contentType: "text/html",
  sizeBytes: 14,
};

function createHandlers(
  overrides: Partial<DocumentCollectionHandlerDependencies<TestClient>> = {}
) {
  const calls = {
    getAuthedClient: 0,
    getCurrentUser: 0,
    listDocuments: 0,
    pageOptions: [] as Array<{ cursor: string | null; numItems: number }>,
    metadata: [] as DocumentCollectionMetadata[],
    deletedKeys: [] as string[],
  };
  const handlers = createDocumentCollectionHandlers<TestClient>({
    getAuthedClient: async () => {
      calls.getAuthedClient += 1;
      return { client: {}, token: "convex-token" };
    },
    getCurrentUser: async () => {
      calls.getCurrentUser += 1;
      return { subject: "owner_123" };
    },
    listDocuments: async () => {
      calls.listDocuments += 1;
      return [{ _id: "document_123", title: "My document" }];
    },
    listDocumentPage: async (_client, options) => {
      calls.pageOptions.push(options);
      return {
        page: [{ _id: "document_123", title: "My document" }],
        isDone: true,
        continueCursor: "end",
      };
    },
    isStorageConfigured: () => true,
    createMetadata: async (_client, input) => {
      calls.metadata.push(input);
      return "document_123";
    },
    deleteStorageObject: async (key) => {
      calls.deletedKeys.push(key);
    },
    missingServerConfigurationResponse: () =>
      Response.json({ error: "backend unavailable" }, { status: 503 }),
    errorResponse: (error) =>
      Response.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 }),
    ...overrides,
  });

  return { calls, handlers };
}

const getRequest = () => new Request("http://localhost/api/documents");

const postRequest = (body: unknown) =>
  new Request("http://localhost/api/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("lists documents for an authenticated request", async () => {
  const { calls, handlers } = createHandlers();
  const response = await handlers.GET({ request: getRequest() });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), [{ _id: "document_123", title: "My document" }]);
  assert.equal(calls.getAuthedClient, 1);
  assert.equal(calls.listDocuments, 1);
});

test("returns an owner-scoped cursor page when pagination is requested", async () => {
  const { calls, handlers } = createHandlers();
  const response = await handlers.GET({
    request: new Request("http://localhost/api/documents?limit=25&cursor=next-page"),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    page: [{ _id: "document_123", title: "My document" }],
    isDone: true,
    continueCursor: "end",
  });
  assert.deepEqual(calls.pageOptions, [{ cursor: "next-page", numItems: 25 }]);
  assert.equal(calls.listDocuments, 0);
});

test("defaults a cursor request to 50 documents", async () => {
  const { calls, handlers } = createHandlers();
  const response = await handlers.GET({
    request: new Request("http://localhost/api/documents?cursor=next-page"),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.pageOptions, [{ cursor: "next-page", numItems: 50 }]);
});

test("rejects invalid pagination before querying documents", async () => {
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=1.5",
    "limit=abc",
    "cursor=",
    "limit=1&limit=2",
  ]) {
    const { calls, handlers } = createHandlers();
    const response = await handlers.GET({
      request: new Request(`http://localhost/api/documents?${query}`),
    });

    assert.equal(response.status, 400, query);
    assert.deepEqual(await response.json(), { error: "Invalid pagination parameters" });
    assert.equal(calls.getAuthedClient, 0);
    assert.equal(calls.listDocuments, 0);
    assert.deepEqual(calls.pageOptions, []);
  }
});

test("does not list documents without an authenticated token", async () => {
  const { calls, handlers } = createHandlers({
    getAuthedClient: async () => {
      calls.getAuthedClient += 1;
      return { client: {}, token: null };
    },
  });
  const response = await handlers.GET({ request: getRequest() });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
  assert.equal(calls.listDocuments, 0);
});

test("maps list failures through the configured error responses", async () => {
  const configurationHandlers = createHandlers({
    getAuthedClient: async () => {
      throw new Error("Convex is not configured");
    },
  });
  const configurationResponse = await configurationHandlers.handlers.GET({ request: getRequest() });

  assert.equal(configurationResponse.status, 503);
  assert.deepEqual(await configurationResponse.json(), { error: "backend unavailable" });

  const failureHandlers = createHandlers({
    listDocuments: async () => {
      throw new Error("query failed");
    },
  });
  const failureResponse = await failureHandlers.handlers.GET({ request: getRequest() });

  assert.equal(failureResponse.status, 500);
  assert.deepEqual(await failureResponse.json(), { error: "query failed" });
});

test("rejects malformed JSON and non-object request bodies", async () => {
  const { calls, handlers } = createHandlers();
  const malformed = await handlers.POST({
    request: new Request("http://localhost/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    }),
  });
  const nullBody = await handlers.POST({ request: postRequest(null) });

  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: "Request body must be valid JSON" });
  assert.equal(nullBody.status, 400);
  assert.deepEqual(await nullBody.json(), {
    error: "A title, uploaded HTML file, content type, and size are required",
  });
  assert.equal(calls.getAuthedClient, 0);
  assert.equal(calls.metadata.length, 0);
});

test("rejects invalid metadata before authenticating or persisting it", async (t) => {
  const invalidCases: Array<{ name: string; body: Record<string, unknown> }> = [
    { name: "blank title", body: { ...validBody, title: "  " } },
    { name: "title over the upload limit", body: { ...validBody, title: "t".repeat(201) } },
    { name: "unsupported storage provider", body: { ...validBody, storageProvider: "other" } },
    { name: "missing upload owner", body: { ...validBody, uploadOwnerId: "" } },
    { name: "missing upload id", body: { ...validBody, uploadCustomId: "" } },
    { name: "non-HTML content", body: { ...validBody, contentType: "text/plain" } },
    { name: "non-numeric size", body: { ...validBody, sizeBytes: "14" } },
    { name: "fractional size", body: { ...validBody, sizeBytes: 1.5 } },
    { name: "negative size", body: { ...validBody, sizeBytes: -1 } },
    { name: "size over the upload limit", body: { ...validBody, sizeBytes: 8 * 1024 * 1024 + 1 } },
  ];

  for (const invalidCase of invalidCases) {
    await t.test(invalidCase.name, async () => {
      const { calls, handlers } = createHandlers();
      const response = await handlers.POST({ request: postRequest(invalidCase.body) });

      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        error: "A title, uploaded HTML file, content type, and size are required",
      });
      assert.equal(calls.getAuthedClient, 0);
      assert.equal(calls.metadata.length, 0);
    });
  }
});

test("requires a signed-in user before creating metadata", async (t) => {
  const cases = [
    {
      name: "missing token",
      getAuthedClient: async () => ({ client: {}, token: null }),
      expectedCurrentUserCalls: 0,
    },
    {
      name: "missing current user",
      getAuthedClient: async () => ({ client: {}, token: "convex-token" }),
      getCurrentUser: async () => null,
      expectedCurrentUserCalls: 1,
    },
  ] as const;

  for (const testCase of cases) {
    await t.test(testCase.name, async () => {
      let currentUserCalls = 0;
      const overrides: Partial<DocumentCollectionHandlerDependencies<TestClient>> = {
        getAuthedClient: async () => {
          return testCase.getAuthedClient();
        },
        getCurrentUser: async () => {
          currentUserCalls += 1;
          return "getCurrentUser" in testCase
            ? testCase.getCurrentUser()
            : { subject: "owner_123" };
        },
      };
      const { calls, handlers } = createHandlers(overrides);
      const response = await handlers.POST({ request: postRequest(validBody) });

      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { error: "Authentication required" });
      assert.equal(currentUserCalls, testCase.expectedCurrentUserCalls);
      assert.equal(calls.metadata.length, 0);
    });
  }
});

test("creates metadata only when both upload owner fields match the signed-in user", async (t) => {
  const invalidOwnershipCases = [
    {
      name: "different owner id",
      uploadOwnerId: "owner_other",
      uploadCustomId: "owner_123:uuid-123",
    },
    {
      name: "different custom id owner",
      uploadOwnerId: "owner_123",
      uploadCustomId: "owner_1234:uuid-123",
    },
  ];

  for (const invalidCase of invalidOwnershipCases) {
    await t.test(invalidCase.name, async () => {
      const { calls, handlers } = createHandlers();
      const response = await handlers.POST({
        request: postRequest({ ...validBody, ...invalidCase }),
      });

      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: "The uploaded file does not belong to this account",
      });
      assert.equal(calls.metadata.length, 0);
    });
  }
});

test("creates the metadata row using the authenticated owner's upload key", async () => {
  const { calls, handlers } = createHandlers();
  const response = await handlers.POST({
    request: postRequest({ ...validBody, title: "  My document  " }),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { id: "document_123" });
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

test("deletes the completed upload when metadata persistence fails", async () => {
  const { calls, handlers } = createHandlers({
    createMetadata: async () => {
      throw new Error("metadata creation failed");
    },
  });
  const response = await handlers.POST({ request: postRequest(validBody) });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "metadata creation failed" });
  assert.deepEqual(calls.deletedKeys, ["uploadthing-custom-id:owner_123:uuid-123"]);
});

test("reports failed compensation and preserves the metadata error response", async () => {
  const metadataCause = new Error("metadata persistence failed");
  const cleanupCause = new Error("storage deletion failed");
  const reports: Array<{
    objectKey: string;
    metadataCause: unknown;
    cleanupCause: unknown;
  }> = [];
  const { calls, handlers } = createHandlers({
    createMetadata: async () => {
      throw metadataCause;
    },
    deleteStorageObject: async (key) => {
      calls.deletedKeys.push(key);
      throw cleanupCause;
    },
    reportCompensationFailure: (failure) => {
      reports.push(failure);
      throw new Error("reporting failed");
    },
  });

  const response = await handlers.POST({ request: postRequest(validBody) });

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "metadata persistence failed" });
  assert.deepEqual(calls.deletedKeys, ["uploadthing-custom-id:owner_123:uuid-123"]);
  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], {
    objectKey: "uploadthing-custom-id:owner_123:uuid-123",
    metadataCause,
    cleanupCause,
  });
});

test("does not persist metadata when file storage is unconfigured", async () => {
  const { calls, handlers } = createHandlers({ isStorageConfigured: () => false });
  const response = await handlers.POST({ request: postRequest(validBody) });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "File storage is not configured yet.",
    code: "STORAGE_NOT_CONFIGURED",
  });
  assert.equal(calls.metadata.length, 0);
});
