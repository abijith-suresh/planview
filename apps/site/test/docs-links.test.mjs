import assert from "node:assert/strict";
import { test } from "node:test";
import { documentationUrl } from "../src/lib/docs-url.ts";

test("legacy marketing guide links resolve to the canonical docs base", () => {
  assert.equal(documentationUrl(), "https://plansplease-docs-staging.up.railway.app/");
  assert.equal(
    documentationUrl("guides/mcp", "https://docs.example.com/manual/"),
    "https://docs.example.com/manual/guides/mcp/"
  );
  assert.throws(() => documentationUrl("", "javascript:alert(1)"));
  assert.throws(() => documentationUrl("", "https://docs.example.com/a//b"));
  assert.throws(() => documentationUrl("../private", "https://docs.example.com"));
});
