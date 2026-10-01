import assert from "node:assert/strict";
import { test } from "node:test";

import { presentMcpUpload } from "../src/lib/mcp-document-links.ts";

test("MCP uploads return the ID and an account workspace preview link", () => {
  assert.deepEqual(presentMcpUpload("document_123", "https://plans.example"), {
    id: "document_123",
    url: "https://plans.example/api/documents/document_123",
  });
});

test("the preview path is rooted at the configured app origin", () => {
  assert.equal(
    presentMcpUpload("document_123", "http://localhost:3000/").url,
    "http://localhost:3000/api/documents/document_123"
  );
});

test("document IDs cannot inject path segments or query parameters", () => {
  assert.deepEqual(presentMcpUpload("id/with?query#fragment", "https://plans.example"), {
    id: "id/with?query#fragment",
    url: "https://plans.example/api/documents/id%2Fwith%3Fquery%23fragment",
  });
});
