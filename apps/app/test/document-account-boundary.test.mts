import assert from "node:assert/strict";
import { test } from "node:test";

import { createDocumentAccountBoundary } from "../src/lib/document-account-boundary.ts";

test("switching accounts clears cached documents and tokens before the new subscription", () => {
  let documents = ["user A document"];
  let token: string | null = "user A token";
  let resets = 0;
  const updateAccount = createDocumentAccountBoundary(() => {
    resets += 1;
    documents = [];
    token = null;
  });
  updateAccount("user A");
  documents = ["user A document"];
  token = "user A token";
  updateAccount("user A");
  assert.equal(resets, 1, "navigation within an account reuses its subscription");
  updateAccount("user B");
  assert.deepEqual(documents, []);
  assert.equal(token, null);
  assert.equal(resets, 2);
});

test("session loss clears the document cache even without the local sign-out button", () => {
  let resets = 0;
  const updateAccount = createDocumentAccountBoundary(() => {
    resets += 1;
  });
  updateAccount("user A");
  updateAccount(null);
  updateAccount(null);
  assert.equal(resets, 2);
});
