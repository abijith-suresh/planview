export type ShareDocument = {
  ownerId: string;
  title: string;
  contentType: string;
  sizeBytes: number;
  storageProvider?: string;
  storageKey?: string;
  storageId?: string;
  deletionRequestedAt?: number;
  shareTokenHash?: string;
};

export const hashShareToken = async (token: string) => {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const activeForOwner = (document: ShareDocument | null, ownerId: string) =>
  document !== null && document.ownerId === ownerId && document.deletionRequestedAt === undefined;

export async function setDocumentSharing(
  dependencies: {
    read(): Promise<ShareDocument | null>;
    update(hash: string | undefined): Promise<void>;
  },
  ownerId: string,
  tokenHash: string | undefined
) {
  if (!ownerId) throw new Error("Authentication required");
  if (tokenHash !== undefined && !/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new Error("Invalid sharing token hash");
  }
  if (!activeForOwner(await dependencies.read(), ownerId)) return false;
  await dependencies.update(tokenHash);
  return true;
}

export async function resolveDocumentShare(
  read: () => Promise<ShareDocument | null>,
  token: string
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const document = await read();
  if (!document?.shareTokenHash || document.deletionRequestedAt !== undefined) return null;
  if ((await hashShareToken(token)) !== document.shareTokenHash) return null;
  // Return only the data needed to render the explicitly shared document.
  return {
    title: document.title,
    contentType: document.contentType,
    sizeBytes: document.sizeBytes,
    ...(document.storageProvider ? { storageProvider: document.storageProvider } : {}),
    ...(document.storageKey ? { storageKey: document.storageKey } : {}),
    ...(document.storageId ? { storageId: document.storageId } : {}),
  };
}
