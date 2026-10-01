import type { Id } from "../../../../convex/_generated/dataModel";

import { getUnauthedConvexClient } from "~/lib/convex-server";
import { documentPreviewResponse } from "~/lib/document-preview";
import { documentSharingFunctions } from "~/lib/document-sharing-functions";
import { createSharedDocumentPreviewHandler } from "~/lib/document-sharing-handlers";
import { getDocumentStorage } from "~/lib/document-storage";

export const GET = createSharedDocumentPreviewHandler({
  resolve: (id: string, token: string) =>
    getUnauthedConvexClient().query(documentSharingFunctions.resolve, {
      id: id as Id<"documents">,
      token,
    }),
  preview: async (result) => {
    if (!result) throw new Error("Document not found");
    const { document, legacyReadUrl } = result;
    if (document.contentType !== "text/html" || document.sizeBytes > 8 * 1024 * 1024) {
      throw new Error("Unsupported document");
    }
    const url =
      document.storageProvider && document.storageKey
        ? await getDocumentStorage(document.storageProvider).getReadUrl(document.storageKey)
        : legacyReadUrl;
    if (!url) throw new Error("Document not found");
    return documentPreviewResponse(url, document.title);
  },
});
