import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createDocumentDeleteHandler,
  createDocumentPreviewHandler,
  type DocumentAccessHandlerDependencies,
  type DocumentAccessRecord,
  type DocumentRouteEvent,
} from "../src/lib/document-access-handlers.ts";

type TestClient = { readonly name: "client" };

const documentId = "document_123";
const storageKey = "uploadthing-custom-id:owner_123:uuid-123";
const storedDocument: DocumentAccessRecord = {
  contentType: "text/html",
  storageProvider: "uploadthing",
  storageKey,
};

type HandlerCalls = {
  events: string[];
  storageLookups: string[];
  readUrlKeys: string[];
  deletedKeys: string[];
  fetches: Array<{ input: string; authorization: string | null }>;
};

function createHandlers(
  overrides:
    | Partial<DocumentAccessHandlerDependencies<TestClient>>
    | ((calls: HandlerCalls) => Partial<DocumentAccessHandlerDependencies<TestClient>>) = {}
) {
  const calls = {
    events: [] as string[],
    storageLookups: [] as string[],
    readUrlKeys: [] as string[],
    deletedKeys: [] as string[],
    fetches: [] as Array<{ input: string; authorization: string | null }>,
  };
  const resolvedOverrides = typeof overrides === "function" ? overrides(calls) : overrides;
  const dependencies: DocumentAccessHandlerDependencies<TestClient> = {
    getAuthedClient: async () => {
      calls.events.push("authenticate");
      return { client: { name: "client" }, token: "convex-token" };
    },
    getDocument: async (_client, id) => {
      calls.events.push("get-document");
      assert.equal(id, documentId);
      return storedDocument;
    },
    getDocumentStorage: (provider) => {
      calls.events.push("get-storage");
      calls.storageLookups.push(provider);
      return {
        provider: "uploadthing",
        getReadUrl: async (key) => {
          calls.events.push("get-read-url");
          calls.readUrlKeys.push(key);
          return "https://storage.example/document.html";
        },
        delete: async (key) => {
          calls.events.push("delete-object");
          calls.deletedKeys.push(key);
        },
      };
    },
    fetch: async (input, init) => {
      calls.events.push("fetch");
      calls.fetches.push({
        input,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return new Response("<h1>Preview</h1>", { status: 200 });
    },
    convexSiteUrl: "https://convex.example",
    proxyResponse: async (response) => {
      calls.events.push("proxy-response");
      return response;
    },
    removeDocument: async () => {
      calls.events.push("remove-document");
    },
    removeDocumentMetadata: async () => {
      calls.events.push("remove-metadata");
    },
    missingServerConfigurationResponse: () =>
      Response.json({ error: "backend unavailable" }, { status: 503 }),
    errorResponse: (error) => {
      calls.events.push("error-response");
      return Response.json(
        { error: error instanceof Error ? error.message : "unknown" },
        { status: 500 }
      );
    },
    ...resolvedOverrides,
  };

  return {
    calls,
    preview: createDocumentPreviewHandler(dependencies),
    remove: createDocumentDeleteHandler(dependencies),
  };
}

const event = (): DocumentRouteEvent => ({
  request: new Request(`http://localhost/api/documents/${documentId}`),
  params: { id: documentId },
});

test("does not look up storage when the authenticated user cannot access a document", async () => {
  const { calls, preview } = createHandlers((calls) => ({
    getDocument: async () => {
      calls.events.push("get-document");
      return null;
    },
  }));

  const response = await preview(event());

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
  assert.deepEqual(calls.events, ["authenticate", "get-document"]);
  assert.deepEqual(calls.storageLookups, []);
  assert.deepEqual(calls.fetches, []);
});

test("requires a session before looking up or reading a document", async () => {
  const { calls, preview, remove } = createHandlers({
    getAuthedClient: async () => {
      calls.events.push("authenticate");
      return { client: { name: "client" }, token: null };
    },
  });

  const previewResponse = await preview(event());
  const deleteResponse = await remove(event());

  assert.equal(previewResponse.status, 401);
  assert.equal(await previewResponse.text(), "Authentication required");
  assert.equal(deleteResponse.status, 401);
  assert.deepEqual(await deleteResponse.json(), { error: "Authentication required" });
  assert.deepEqual(calls.events, ["authenticate", "authenticate"]);
  assert.deepEqual(calls.storageLookups, []);
});

test("serves stored HTML with private preview security headers", async () => {
  const { calls, preview } = createHandlers();

  const response = await preview(event());

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "<h1>Preview</h1>");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-disposition"), "inline");
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(
    response.headers.get("content-security-policy"),
    "default-src 'none'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-modals allow-popups; script-src 'unsafe-inline' https: blob:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: blob: https:; media-src data: blob: https:; connect-src https:; worker-src blob: https:; frame-src https:"
  );
  assert.equal(
    response.headers.get("permissions-policy"),
    "camera=(), geolocation=(), microphone=(), payment=()"
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(calls.storageLookups, ["uploadthing"]);
  assert.deepEqual(calls.readUrlKeys, [storageKey]);
  assert.deepEqual(calls.fetches, [
    { input: "https://storage.example/document.html", authorization: null },
  ]);
});

test("maps a failed storage response to not found", async () => {
  const { calls, preview } = createHandlers({
    fetch: async () => {
      calls.events.push("fetch");
      return new Response("upstream unavailable", { status: 502 });
    },
  });

  const response = await preview(event());

  assert.equal(response.status, 404);
  assert.equal(await response.text(), "Not found");
});

test("maps a storage fetch rejection through the route error handler", async () => {
  const { preview } = createHandlers({
    fetch: async () => {
      throw new Error("storage fetch failed");
    },
  });

  const response = await preview(event());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "storage fetch failed" });
});

test("proxies legacy Convex-backed documents with the authenticated token", async () => {
  const { calls, preview } = createHandlers({
    getDocument: async () => ({ contentType: "text/html" }),
  });

  const response = await preview(event());

  assert.equal(response.status, 200);
  assert.deepEqual(calls.fetches, [
    {
      input: `https://convex.example/documents/content?id=${documentId}`,
      authorization: "Bearer convex-token",
    },
  ]);
  assert.ok(calls.events.includes("proxy-response"));
  assert.deepEqual(calls.storageLookups, []);
});

test("deletes the remote object before its Convex metadata", async () => {
  const { calls, remove } = createHandlers();

  const response = await remove(event());

  assert.equal(response.status, 204);
  assert.deepEqual(calls.deletedKeys, [storageKey]);
  assert.deepEqual(calls.events, [
    "authenticate",
    "get-document",
    "get-storage",
    "delete-object",
    "remove-metadata",
  ]);
});

test("keeps Convex metadata when deleting the remote object fails", async () => {
  const { calls, remove } = createHandlers((calls) => ({
    getDocumentStorage: () => ({
      provider: "uploadthing",
      getReadUrl: async () => "https://storage.example/document.html",
      delete: async () => {
        calls.events.push("delete-object");
        throw new Error("storage deletion failed");
      },
    }),
  }));

  const response = await remove(event());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "storage deletion failed" });
  assert.deepEqual(calls.events, [
    "authenticate",
    "get-document",
    "delete-object",
    "error-response",
  ]);
});

test("reports metadata deletion failure after the remote object is removed", async () => {
  let metadataDeletionAttempted = false;
  const { calls, remove } = createHandlers({
    removeDocumentMetadata: async () => {
      metadataDeletionAttempted = true;
      throw new Error("metadata deletion failed");
    },
  });

  const response = await remove(event());

  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "metadata deletion failed" });
  assert.equal(metadataDeletionAttempted, true);
  assert.deepEqual(calls.events, [
    "authenticate",
    "get-document",
    "get-storage",
    "delete-object",
    "error-response",
  ]);
});

test("uses the legacy Convex removal mutation when the document has no external storage key", async () => {
  const { calls, remove } = createHandlers((calls) => ({
    getDocument: async () => {
      calls.events.push("get-document");
      return { contentType: "text/html", storageProvider: "uploadthing" };
    },
  }));

  const response = await remove(event());

  assert.equal(response.status, 204);
  assert.deepEqual(calls.events, ["authenticate", "get-document", "remove-document"]);
  assert.deepEqual(calls.storageLookups, []);
});
