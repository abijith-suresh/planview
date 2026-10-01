import { randomUUID } from "node:crypto";
import { readBundleText, listBundleFilePage } from "./mcp-bundle-reads.ts";
import { cloudBundleContentType, packCloudBundle, cloudBundleMime } from "./cloud-bundle.ts";
import { serverBundleReadCache, bundleCacheKey, readBoundedBundle } from "./bundle-read-cache.ts";

import type { Id } from "../../convex/_generated/dataModel";

import { api, getUnauthedConvexClient } from "./convex-server";
import { createDocumentReadCache } from "./document-read-cache";
import { uploadHtmlFile } from "./document-file-upload";
import { createDocumentProof, createAbandonDocumentProof } from "./document-mutation-proof";
import { getDocumentStorage } from "./document-storage";
import { uploadReservedDocument } from "./reserved-document-upload";
import { createMcpDocumentProof } from "./mcp-document-proof";

const maxFileBytes = 8 * 1024 * 1024;
const maxReadCharacters = 32_768;
// Each MCP request creates a service, but sequential chunk reads can share one
// bounded document in this process. Access is still checked by Convex first.
const documentReadCache = createDocumentReadCache();
const bundleReadCache = serverBundleReadCache;

export type McpDocument = {
  id: string;
  title: string;
  sizeBytes: number;
  createdAt: number;
  kind?: "bundle";
};

const present = (document: {
  _id: Id<"documents">;
  title: string;
  sizeBytes: number;
  createdAt: number;
  contentType?: string;
}): McpDocument => ({
  id: document._id,
  title: document.title,
  sizeBytes: document.sizeBytes,
  createdAt: document.createdAt,
  ...(document.contentType === cloudBundleContentType ? { kind: "bundle" as const } : {}),
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

  const upload = async (
    title: string,
    bytes: Uint8Array<ArrayBuffer>,
    contentType: "text/html" | typeof cloudBundleContentType
  ) => {
    const cleanTitle = title.trim();
    if (cleanTitle.length < 1 || cleanTitle.length > 200) {
      throw new Error("Title must be between 1 and 200 characters");
    }
    if (bytes.length > maxFileBytes) throw new Error("Document exceeds the 8 MiB limit");
    const customId = `${ownerId}:${randomUUID()}`;
    const storageKey = `uploadthing-custom-id:${customId}`;
    const input = {
      title: cleanTitle,
      storageProvider: "uploadthing" as const,
      storageKey,
      contentType,
      sizeBytes: bytes.length,
    };
    const arguments_ = [
      input.title,
      input.storageProvider,
      input.storageKey,
      input.contentType,
      input.sizeBytes,
    ];
    const uploadArguments = async (action: "reserve" | "create" | "abandon") => ({
      ownerId,
      ...input,
      proof: await createMcpDocumentProof({ action, ownerId, arguments: arguments_ }),
      createProof: await createDocumentProof({ ownerId, ...input }),
    });
    const id = await uploadReservedDocument({
      metadata: input,
      file: new File(
        [bytes],
        contentType === cloudBundleContentType ? "document.planview" : "document.html",
        { type: contentType }
      ),
      customId,
      reserve: async () =>
        client.mutation(api.mcpDocuments.reserveUpload, await uploadArguments("reserve")),
      upload: uploadHtmlFile,
      commit: async () => client.mutation(api.mcpDocuments.create, await uploadArguments("create")),
      abandon: async (uploadConfirmed) =>
        client.mutation(api.mcpDocuments.abandonUpload, {
          ...(await uploadArguments("abandon")),
          uploadConfirmed,
          proof: await createMcpDocumentProof({
            action: "abandon",
            ownerId,
            arguments: [...arguments_, Number(uploadConfirmed)],
          }),
          outcomeProof: await createAbandonDocumentProof({ ownerId, ...input, uploadConfirmed }),
        }),
    });
    return { id };
  };

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

    async read(id: string, offset = 0, maxCharacters = maxReadCharacters, path?: string) {
      if (path !== undefined) cloudBundleMime(path);
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
      if (document.contentType === cloudBundleContentType) {
        const url = await getDocumentStorage(document.storageProvider!).getReadUrl(
          document.storageKey!
        );
        const bundle = await bundleReadCache.load(
          bundleCacheKey(document.storageProvider!, document.storageKey!),
          () => fetch(url, { signal: AbortSignal.timeout(20_000) }).then(readBoundedBundle)
        );
        return {
          ...present(document),
          ...readBundleText(bundle, path ?? "index.html", offset, maxCharacters),
        };
      }
      if (path !== undefined && path !== "index.html")
        throw new Error("Standalone HTML documents do not contain asset files");
      const html = await documentReadCache.load(JSON.stringify([ownerId, id]), async () => {
        const url =
          document.storageProvider && document.storageKey
            ? await getDocumentStorage(document.storageProvider).getReadUrl(document.storageKey)
            : legacyReadUrl;
        if (!url) throw new Error("Document content is unavailable");
        return readBoundedHtml(await fetch(url, { signal: AbortSignal.timeout(20_000) }));
      });
      return {
        ...present(document),
        offset,
        totalCharacters: html.length,
        html: html.slice(offset, offset + maxCharacters),
        nextOffset: offset + maxCharacters < html.length ? offset + maxCharacters : null,
      };
    },

    upload(title: string, html: string) {
      return upload(title, new TextEncoder().encode(html), "text/html");
    },
    async uploadBundle(title: string, files: readonly { path: string; content: string }[]) {
      const result = await upload(
        title,
        new Uint8Array(packCloudBundle(files)),
        cloudBundleContentType
      );
      return { ...result, kind: "bundle" as const, fileCount: files.length };
    },

    async listBundleFiles(id: string, offset = 0, limit = 50) {
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 50
      )
        throw new Error("Invalid bundle file page");
      const result = await client.query(api.mcpDocuments.get, {
        ownerId,
        id: id as Id<"documents">,
        proof: await createMcpDocumentProof({ action: "get", ownerId, arguments: [id] }),
      });
      if (!result) return null;
      const { document } = result;
      if (
        document.contentType !== cloudBundleContentType ||
        !document.storageProvider ||
        !document.storageKey
      )
        throw new Error("Document is not a bundle");
      const bundle = await bundleReadCache.load(
        bundleCacheKey(document.storageProvider!, document.storageKey!),
        async () => {
          const url = await getDocumentStorage(document.storageProvider!).getReadUrl(
            document.storageKey!
          );
          return readBoundedBundle(await fetch(url, { signal: AbortSignal.timeout(20_000) }));
        }
      );
      return { id, ...listBundleFilePage(bundle, offset, limit) };
    },

    async delete(id: string) {
      const result = await client.mutation(api.mcpDocuments.requestDeletion, {
        ownerId,
        id: id as Id<"documents">,
        proof: await createMcpDocumentProof({ action: "delete", ownerId, arguments: [id] }),
      });
      documentReadCache.invalidate(JSON.stringify([ownerId, id]));
      return result;
    },
  };
}
