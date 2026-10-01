import { makeFunctionReference } from "convex/server";
import type { Id } from "../../../../../../convex/_generated/dataModel";

import { getUnauthedConvexClient } from "~/lib/convex-server";
import {
  createSharedBundleAssetHandler,
  type SharedBundleDocument,
} from "~/lib/shared-bundle-asset-handler";
import { serverBundleReadCache, bundleCacheKey, readBoundedBundle } from "~/lib/bundle-read-cache";
import { getDocumentStorage } from "~/lib/document-storage";

// This optional backend function is supplied by the separate sharing feature.
// Missing installations and all denied lookups produce the same opaque 404.
const resolve = makeFunctionReference<
  "query",
  { id: Id<"documents">; token: string },
  { document: SharedBundleDocument; legacyReadUrl: string | null } | null
>("documentSharing:resolve");
export const GET = createSharedBundleAssetHandler({
  resolve: (id, token) =>
    getUnauthedConvexClient().query(resolve, { id: id as Id<"documents">, token }),
  load: (document) =>
    serverBundleReadCache.load(
      bundleCacheKey(document.storageProvider!, document.storageKey!),
      async () => {
        const url = await getDocumentStorage(document.storageProvider!).getReadUrl(
          document.storageKey!
        );
        return readBoundedBundle(
          await fetch(url, {
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(20_000),
          })
        );
      }
    ),
});
