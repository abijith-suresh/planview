import assert from "node:assert/strict";
import { test } from "node:test";

import {
  signCreateDocumentProof,
  signRemoveDocumentProof,
  verifyCreateDocumentProof,
  verifyRemoveDocumentProof,
} from "../convex/document-proof.ts";

const secret = "test-secret-for-document-mutation-proofs";
const createInput = {
  ownerId: "owner_123",
  title: "My document",
  storageProvider: "uploadthing",
  storageKey: "uploadthing-custom-id:owner_123:uuid-123",
  contentType: "text/html",
  sizeBytes: 42,
};

test("create proof binds the owner and every stored metadata field", async () => {
  const proof = await signCreateDocumentProof(secret, createInput);

  assert.equal(await verifyCreateDocumentProof(secret, createInput, proof), true);
  assert.equal(
    await verifyCreateDocumentProof(secret, { ...createInput, ownerId: "owner_other" }, proof),
    false
  );
  assert.equal(
    await verifyCreateDocumentProof(secret, { ...createInput, sizeBytes: 43 }, proof),
    false
  );
  assert.equal(await verifyCreateDocumentProof("wrong-secret", createInput, proof), false);
  assert.equal(
    await verifyCreateDocumentProof(secret, createInput, proof, proof.expiresAt + 1),
    false
  );
});

test("remove proof binds the owner and document ID", async () => {
  const proof = await signRemoveDocumentProof(secret, "owner_123", "document_123");

  assert.equal(await verifyRemoveDocumentProof(secret, "owner_123", "document_123", proof), true);
  assert.equal(
    await verifyRemoveDocumentProof(secret, "owner_other", "document_123", proof),
    false
  );
  assert.equal(
    await verifyRemoveDocumentProof(secret, "owner_123", "document_other", proof),
    false
  );
  assert.equal(
    await verifyRemoveDocumentProof(
      secret,
      "owner_123",
      "document_123",
      proof,
      proof.expiresAt + 1
    ),
    false
  );
});
