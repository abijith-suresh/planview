export type McpDocumentAction = "list" | "get" | "create" | "delete";

export type McpDocumentProof = Readonly<{
  expiresAt: number;
  signature: string;
}>;

export type McpDocumentProofInput = Readonly<{
  action: McpDocumentAction;
  ownerId: string;
  arguments: readonly (string | number | null)[];
}>;

const lifetimeMs = 60_000;
const maxClockSkewMs = 30_000;
const encoder = new TextEncoder();

const message = (input: McpDocumentProofInput, expiresAt: number) =>
  JSON.stringify([
    "planview-mcp-documents-v1",
    input.action,
    input.ownerId,
    input.arguments,
    expiresAt,
  ]);

const importKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const signMcpDocumentProof = async (secret: string, input: McpDocumentProofInput) => {
  const expiresAt = Date.now() + lifetimeMs;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await importKey(secret),
      encoder.encode(message(input, expiresAt))
    )
  );
  return { expiresAt, signature: toHex(signature) };
};

export const verifyMcpDocumentProof = async (
  secret: string,
  input: McpDocumentProofInput,
  proof: McpDocumentProof,
  now = Date.now()
) => {
  if (
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.expiresAt < now ||
    proof.expiresAt > now + lifetimeMs + maxClockSkewMs ||
    !/^[a-f0-9]{64}$/.test(proof.signature)
  ) {
    return false;
  }
  const signature = Uint8Array.from(proof.signature.match(/.{2}/g) ?? [], (part) =>
    Number.parseInt(part, 16)
  );
  return crypto.subtle.verify(
    "HMAC",
    await importKey(secret),
    signature,
    encoder.encode(message(input, proof.expiresAt))
  );
};
