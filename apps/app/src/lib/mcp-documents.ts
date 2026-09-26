import { randomUUID } from "node:crypto";

import type { Id } from "../../convex/_generated/dataModel";

import { api, getUnauthedConvexClient } from "./convex-server";
import { uploadHtmlFile } from "./document-file-upload";
import { createDocumentProof } from "./document-mutation-proof";
import { getDocumentStorage } from "./document-storage";
import { reportDocumentUploadCompensationFailure } from "./document-upload-compensation";
import { createMcpDocumentProof } from "./mcp-document-proof";

const maxFileBytes = 8 * 1024 * 1024;
const maxReadCharacters = 32_768;

export type McpDocument = {
  id: string;
  title: string;
  sizeBytes: number;
  createdAt: number;
};

const present = (document: {
  _id: Id<"documents">;
  title: string;
  sizeBytes: number;
  createdAt: number;
}): McpDocument => ({
  id: document._id,
  title: document.title,
  sizeBytes: document.sizeBytes,
  createdAt: document.createdAt,
});

const readBoundedHtml = async (response: Response) => {
  if (!response.ok || !response.body) throw new Error("Document content is unavailable");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxFileBytes) throw new Error("Document content exceeds the 8 MiB limit");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

export function createMcpDocumentService(ownerId: string) {
  if (!ownerId) throw new Error("MCP identity is missing");
  const client = getUnauthedConvexClient();

  return {
    async list(cursor: string | null = null, limit = 25) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
        throw new Error("Page size must be between 1 and 50");
      }
      const page = await client.query(api.mcpDocuments.listPage, {
        ownerId,
        paginationOpts: { cursor, numItems: limit },
        proof: await createMcpDocumentProof({
          action: "list",
          ownerId,
          arguments: [cursor, limit],
        }),
      });
      return {
        documents: page.page.map(present),
        nextCursor: page.isDone ? null : page.continueCursor,
      };
    },

    async read(id: string, offset = 0, maxCharacters = maxReadCharacters) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid read offset");
      if (
        !Number.isSafeInteger(maxCharacters) ||
        maxCharacters < 1 ||
        maxCharacters > maxReadCharacters
      ) {
        throw new Error("Read length must be between 1 and 32768 characters");
      }
      const result = await client.query(api.mcpDocuments.get, {
        ownerId,
        id: id as Id<"documents">,
        proof: await createMcpDocumentProof({ action: "get", ownerId, arguments: [id] }),
      });
      if (!result) return null;
      const { document, legacyReadUrl } = result;
      const url =
        document.storageProvider && document.storageKey
          ? await getDocumentStorage(document.storageProvider).getReadUrl(document.storageKey)
          : legacyReadUrl;
      if (!url) throw new Error("Document content is unavailable");
      const html = await readBoundedHtml(await fetch(url, { signal: AbortSignal.timeout(20_000) }));
      return {
        ...present(document),
        offset,
        totalCharacters: html.length,
        html: html.slice(offset, offset + maxCharacters),
        nextOffset: offset + maxCharacters < html.length ? offset + maxCharacters : null,
      };
    },

    async upload(title: string, html: string) {
      const cleanTitle = title.trim();
      const bytes = new TextEncoder().encode(html);
      if (cleanTitle.length < 1 || cleanTitle.length > 200) {
        throw new Error("Title must be between 1 and 200 characters");
      }
      if (bytes.length > maxFileBytes) throw new Error("HTML exceeds the 8 MiB limit");
      const customId = `${ownerId}:${randomUUID()}`;
      const storageKey = `uploadthing-custom-id:${customId}`;
      await uploadHtmlFile({
        file: new File([bytes], "document.html", { type: "text/html" }),
        customId,
      });
      const input = {
        title: cleanTitle,
        storageProvider: "uploadthing" as const,
        storageKey,
        contentType: "text/html" as const,
        sizeBytes: bytes.length,
      };
      try {
        const id = await client.mutation(api.mcpDocuments.create, {
          ownerId,
          ...input,
          proof: await createMcpDocumentProof({
            action: "create",
            ownerId,
            arguments: [
              input.title,
              input.storageProvider,
              input.storageKey,
              input.contentType,
              input.sizeBytes,
            ],
          }),
          createProof: await createDocumentProof({ ownerId, ...input }),
        });
        return { id };
      } catch (metadataCause) {
        try {
          await getDocumentStorage("uploadthing").delete(storageKey);
        } catch (cleanupCause) {
          await reportDocumentUploadCompensationFailure(undefined, {
            objectKey: storageKey,
            metadataCause,
            cleanupCause,
          });
        }
        throw metadataCause;
      }
    },

    async delete(id: string) {
      return client.mutation(api.mcpDocuments.requestDeletion, {
        ownerId,
        id: id as Id<"documents">,
        proof: await createMcpDocumentProof({ action: "delete", ownerId, arguments: [id] }),
      });
    },
  };
}
