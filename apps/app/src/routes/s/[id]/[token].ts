import type { Id } from "../../../../convex/_generated/dataModel";

import { getUnauthedConvexClient } from "~/lib/convex-server";
import { documentPreviewResponse } from "~/lib/document-preview";
import { documentSharingFunctions } from "~/lib/document-sharing-functions";
import {
  createSharedDocumentPreviewHandler,
  sharedBundlePreviewResponse,
} from "~/lib/document-sharing-handlers";
import { getDocumentStorage } from "~/lib/document-storage";

export const GET = createSharedDocumentPreviewHandler({
  resolve: (id: string, token: string) =>
    getUnauthedConvexClient().query(documentSharingFunctions.resolve, {
      id: id as Id<"documents">,
      token,
    }),
  preview: async (result, { id, token }) => {
    if (!result) throw new Error("Document not found");
    const { document, legacyReadUrl } = result;
    if (document.sizeBytes > 8 * 1024 * 1024) {
      throw new Error("Unsupported document");
    }
    // The cloud-bundle feature supplies this asset route. The sharing backend
    // and standalone viewer can ship independently of that feature.
    if (document.contentType === "application/vnd.planview.bundle") {
      return sharedBundlePreviewResponse(id, token);
    }
    if (document.contentType !== "text/html") throw new Error("Unsupported document");
    const url =
      document.storageProvider && document.storageKey
        ? await getDocumentStorage(document.storageProvider).getReadUrl(document.storageKey)
        : legacyReadUrl;
    if (!url) throw new Error("Document not found");
    return documentPreviewResponse(url, document.title);
  },
});
