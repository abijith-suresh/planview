export type DocumentMutationProof = Readonly<{
  expiresAt: number;
  signature: string;
}>;

export type CreateDocumentProofInput = Readonly<{
  ownerId: string;
  title: string;
  storageProvider: string;
  storageKey: string;
  contentType: string;
  sizeBytes: number;
}>;

const PROOF_LIFETIME_MS = 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;
const encoder = new TextEncoder();

const createMessage = (input: CreateDocumentProofInput, expiresAt: number) =>
  JSON.stringify([
    "create",
    input.ownerId,
    input.title,
    input.storageProvider,
    input.storageKey,
    input.contentType,
    input.sizeBytes,
    expiresAt,
  ]);

const importKey = (secret: string) =>
  crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const fromHex = (value: string) => {
  if (!/^[a-f0-9]{64}$/.test(value)) return null;
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
};

const verify = async (
  secret: string,
  proof: DocumentMutationProof,
  message: string,
  now = Date.now()
) => {
  if (
    !Number.isSafeInteger(proof.expiresAt) ||
    proof.expiresAt < now ||
    proof.expiresAt > now + PROOF_LIFETIME_MS + MAX_CLOCK_SKEW_MS
  ) {
    return false;
  }
  const signature = fromHex(proof.signature);
  if (!signature) return false;
  return crypto.subtle.verify("HMAC", await importKey(secret), signature, encoder.encode(message));
};

export const signCreateDocumentProof = async (secret: string, input: CreateDocumentProofInput) => {
  const expiresAt = Date.now() + PROOF_LIFETIME_MS;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      await importKey(secret),
      encoder.encode(createMessage(input, expiresAt))
    )
  );
  return { expiresAt, signature: toHex(signature) };
};

export const verifyCreateDocumentProof = (
  secret: string,
  input: CreateDocumentProofInput,
  proof: DocumentMutationProof,
  now = Date.now()
) => verify(secret, proof, createMessage(input, proof.expiresAt), now);
