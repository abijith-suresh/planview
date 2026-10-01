import assert from "node:assert/strict";
import { test } from "node:test";

import {
  hashShareToken,
  resolveDocumentShare,
  setDocumentSharing,
  type ShareDocument,
} from "../convex/documentSharingModel.ts";
import { signMcpDocumentProof, verifyMcpDocumentProof } from "../convex/mcpProof.ts";
import { createDocumentShareToken, documentShareUrl } from "../src/lib/document-share-token.ts";
import {
  createDocumentSharingHandlers,
  createSharedDocumentPreviewHandler,
} from "../src/lib/document-sharing-handlers.ts";

const document = (): ShareDocument => ({
  ownerId: "owner-a",
  title: "Plan",
  contentType: "text/html",
  sizeBytes: 12,
  storageProvider: "uploadthing",
  storageKey: "file-key",
});

test("sharing is disabled until the owner enables it, and rotation and revocation invalidate old links", async () => {
  const record = document();
  const first = await createDocumentShareToken();
  const second = await createDocumentShareToken();
  const deps = {
    read: async () => record,
    update: async (hash: string | undefined) => {
      if (hash) record.shareTokenHash = hash;
      else delete record.shareTokenHash;
    },
  };
  assert.equal(await resolveDocumentShare(deps.read, first.token), null);
  assert.equal(await setDocumentSharing(deps, "owner-a", first.tokenHash), true);
  assert.deepEqual(await resolveDocumentShare(deps.read, first.token), {
    title: "Plan",
    contentType: "text/html",
    sizeBytes: 12,
    storageProvider: "uploadthing",
    storageKey: "file-key",
  });
  assert.equal(await setDocumentSharing(deps, "owner-a", second.tokenHash), true);
  assert.equal(await resolveDocumentShare(deps.read, first.token), null);
  assert.notEqual(await resolveDocumentShare(deps.read, second.token), null);
  await setDocumentSharing(deps, "owner-a", undefined);
  assert.equal(await resolveDocumentShare(deps.read, second.token), null);
});

test("other accounts cannot create or revoke a share and deletion immediately hides shared content", async () => {
  const record = document();
  const issued = await createDocumentShareToken();
  record.shareTokenHash = issued.tokenHash;
  let writes = 0;
  const deps = {
    read: async () => record,
    update: async () => {
      writes += 1;
    },
  };
  assert.equal(await setDocumentSharing(deps, "owner-b", issued.tokenHash), false);
  assert.equal(await setDocumentSharing(deps, "owner-b", undefined), false);
  record.deletionRequestedAt = Date.now();
  assert.equal(await setDocumentSharing(deps, "owner-a", issued.tokenHash), false);
  assert.equal(await resolveDocumentShare(deps.read, issued.token), null);
  assert.equal(writes, 0);
});

test("share tokens have 256-bit entropy format and invalid tokens do not read metadata", async () => {
  const first = await createDocumentShareToken();
  const second = await createDocumentShareToken();
  assert.match(first.token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.token, second.token);
  assert.equal(first.tokenHash, await hashShareToken(first.token));
  for (const token of ["", "guess", first.tokenHash, `${first.token}/other`]) {
    assert.equal(
      await resolveDocumentShare(async () => {
        throw new Error("unexpected read");
      }, token),
      null
    );
  }
});

test("MCP share authorization binds the caller, document, operation, and token hash", async () => {
  const secret = "a-test-secret-at-least-thirty-two-bytes";
  const token = await createDocumentShareToken();
  const input = {
    action: "create-share" as const,
    ownerId: "owner-a",
    arguments: ["document-a", token.tokenHash],
  };
  const proof = await signMcpDocumentProof(secret, input);
  assert.equal(await verifyMcpDocumentProof(secret, input, proof), true);
  for (const modified of [
    { ...input, ownerId: "owner-b" },
    { ...input, arguments: ["document-b", token.tokenHash] },
    { ...input, action: "revoke-share" as const },
    { ...input, arguments: ["document-a", "0".repeat(64)] },
  ])
    assert.equal(await verifyMcpDocumentProof(secret, modified, proof), false);
});

test("share management requires an owner session and leaves failed requests without a link", async () => {
  let authenticated = false;
  let owned = true;
  let writes = 0;
  const handlers = createDocumentSharingHandlers({
    getAuthedClient: async () => ({ client: {}, token: authenticated ? "jwt" : null }),
    createToken: createDocumentShareToken,
    shareUrl: (id, token) => documentShareUrl("https://app.example.test", id, token),
    enable: async () => {
      writes += 1;
      return owned;
    },
    disable: async () => {
      writes += 1;
      return owned;
    },
    errorResponse: () => new Response("error", { status: 500 }),
  });
  const event = {
    request: new Request("https://app.example.test/api/documents/a/share"),
    params: { id: "a" },
  };
  assert.equal((await handlers.POST(event)).status, 401);
  assert.equal((await handlers.DELETE(event)).status, 401);
  assert.equal(writes, 0);
  authenticated = true;
  for (const headers of [
    { origin: "https://another.example.test" },
    { origin: "null" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const crossOrigin = {
      ...event,
      request: new Request(event.request.url, { headers }),
    };
    assert.equal((await handlers.POST(crossOrigin)).status, 403);
    assert.equal((await handlers.DELETE(crossOrigin)).status, 403);
  }
  assert.equal(writes, 0);
  const response = await handlers.POST(event);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.match(
    (await response.json()).url,
    /^https:\/\/app\.example\.test\/s\/a\/[A-Za-z0-9_-]{43}$/
  );
  owned = false;
  assert.equal((await handlers.POST(event)).status, 404);
  assert.equal((await handlers.DELETE(event)).status, 404);
});

test("anonymous share previews check every request, forbid caching/indexing, and hide provider errors", async () => {
  const token = (await createDocumentShareToken()).token;
  let enabled = true;
  let resolveCalls = 0;
  const preview = createSharedDocumentPreviewHandler({
    resolve: async () => {
      resolveCalls += 1;
      return enabled ? { url: "https://files.example.test" } : null;
    },
    preview: async () =>
      new Response("sandboxed viewer", {
        headers: { "Content-Security-Policy": "sandbox allow-scripts" },
      }),
  });
  const event = { params: { id: "a", token } };
  const response = await preview(event);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow, noarchive");
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("Content-Security-Policy"), "sandbox allow-scripts");
  enabled = false;
  assert.equal((await preview(event)).status, 404);
  assert.equal(resolveCalls, 2);
  assert.equal((await preview({ params: { id: "a", token: "guess" } })).status, 404);
  assert.equal(resolveCalls, 2);
  const failed = createSharedDocumentPreviewHandler({
    resolve: async () => {
      throw new Error("private locator");
    },
    preview: async () => new Response(),
  });
  const failure = await failed(event);
  assert.equal(failure.status, 404);
  assert.equal(await failure.text(), "Not found");
});

test("share links cannot use an unsafe deployment origin or token path injection", () => {
  const token = "a".repeat(43);
  assert.equal(
    documentShareUrl("https://app.example.test/", "folder/document", token),
    `https://app.example.test/s/folder%2Fdocument/${token}`
  );
  for (const origin of [
    "javascript:alert(1)",
    "http://app.example.test",
    "https://user:password@app.example.test",
    "https://app.example.test/other",
    "https://app.example.test/?a=1",
  ]) {
    assert.throws(() => documentShareUrl(origin, "a", token));
  }
  assert.throws(() => documentShareUrl("https://app.example.test", "a", "../other"));
});
