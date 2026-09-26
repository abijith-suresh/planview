import assert from "node:assert/strict";
import { test } from "node:test";

import { signMcpDocumentProof, verifyMcpDocumentProof } from "../convex/mcp-proof.ts";

const secret = "a-32-byte-secret-for-mcp-proofs-and-tests";
const input = { action: "delete" as const, ownerId: "user-one", arguments: ["document-one"] };

test("MCP proof binds account, operation, arguments, and expiry", async () => {
  const proof = await signMcpDocumentProof(secret, input);
  assert.equal(await verifyMcpDocumentProof(secret, input, proof), true);
  assert.equal(
    await verifyMcpDocumentProof(secret, { ...input, ownerId: "user-two" }, proof),
    false
  );
  assert.equal(await verifyMcpDocumentProof(secret, { ...input, action: "get" }, proof), false);
  assert.equal(
    await verifyMcpDocumentProof(secret, { ...input, arguments: ["document-two"] }, proof),
    false
  );
  assert.equal(await verifyMcpDocumentProof(secret, input, proof, proof.expiresAt + 1), false);
});
