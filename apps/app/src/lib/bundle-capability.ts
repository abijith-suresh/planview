import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const domain = "planview-cloud-bundle-read-v1";
const lifetimeMs = 5 * 60_000;
export type BundleCapability = {
  documentId: string;
  ownerId: string;
  storageProvider: string;
  storageKey: string;
  expiresAt: number;
};

const key = (secret: string) => {
  if (Buffer.byteLength(secret) < 32)
    throw new Error("Document mutation signing is not configured");
  return createHash("sha256").update(domain).update("\0").update(secret).digest();
};
const validClaims = (value: unknown, now: number): value is BundleCapability => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    ["documentId", "ownerId", "storageProvider", "storageKey"].every(
      (name) =>
        typeof record[name] === "string" &&
        (record[name] as string).length > 0 &&
        (record[name] as string).length <= 1024
    ) &&
    Number.isSafeInteger(record["expiresAt"]) &&
    (record["expiresAt"] as number) > now &&
    (record["expiresAt"] as number) <= now + lifetimeMs
  );
};

export function createBundleCapability(
  secret: string,
  input: Omit<BundleCapability, "expiresAt">,
  now = Date.now()
) {
  const claims = { ...input, expiresAt: now + lifetimeMs };
  if (!validClaims(claims, now)) throw new Error("Invalid bundle capability claims");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(secret), nonce);
  cipher.setAAD(Buffer.from(domain));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(claims), "utf8"), cipher.final()]);
  const token = Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64url");
  if (token.length > 4096) throw new Error("Invalid bundle capability claims");
  return token;
}

export function verifyBundleCapability(
  secret: string,
  documentId: string,
  token: string,
  now = Date.now()
): BundleCapability | null {
  if (token.length > 4096 || token.length < 40 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const packet = Buffer.from(token, "base64url");
    if (packet.toString("base64url") !== token || packet.byteLength < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key(secret), packet.subarray(0, 12));
    decipher.setAAD(Buffer.from(domain));
    decipher.setAuthTag(packet.subarray(-16));
    const plaintext = Buffer.concat([decipher.update(packet.subarray(12, -16)), decipher.final()]);
    const claims: unknown = JSON.parse(plaintext.toString("utf8"));
    return validClaims(claims, now) && claims.documentId === documentId ? claims : null;
  } catch {
    return null;
  }
}

export function bundleEntryUrl(siteUrl: string, id: string, token: string, path = "index.html") {
  const origin = new URL(siteUrl);
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (origin.protocol !== "https:" &&
      !(
        origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname)
      ))
  ) {
    throw new Error("Bundle preview origin must be a configured HTTPS origin");
  }
  return new URL(`/api/bundles/${encodeURIComponent(id)}/${token}/${path}`, origin.origin).href;
}
