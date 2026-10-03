import type { Id } from "../../../../../../convex/_generated/dataModel";

import { api, getUnauthedConvexClient } from "~/lib/convex-server";
import { createBundleAssetHandler } from "~/lib/bundle-asset-handler";
import { serverBundleReadCache, bundleCacheKey, readBoundedBundle } from "~/lib/bundle-read-cache";
import { getDocumentStorage } from "~/lib/document-storage";
import { requireMutationSecret } from "~/lib/document-mutation-proof";
import { createMcpDocumentProof } from "~/lib/mcp-document-proof";

const cache = serverBundleReadCache;
export const GET = createBundleAssetHandler({
  secret: requireMutationSecret,
  getDocument: async ({ ownerId, documentId }) => {
    const result = await getUnauthedConvexClient().query(api.mcpDocuments.get, {
      ownerId,
      id: documentId as Id<"documents">,
      proof: await createMcpDocumentProof({ action: "get", ownerId, arguments: [documentId] }),
    });
    return result?.document ?? null;
  },
  load: (claims) =>
    cache.load(bundleCacheKey(claims.storageProvider, claims.storageKey), async () => {
      const url = await getDocumentStorage(claims.storageProvider).getReadUrl(claims.storageKey);
      return readBoundedBundle(
        await fetch(url, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(20_000),
        })
      );
    }),
});
