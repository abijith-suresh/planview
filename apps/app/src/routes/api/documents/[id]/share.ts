import type { Id } from "../../../../../convex/_generated/dataModel";

import { errorResponse, getAuthedConvexClient } from "~/lib/convex-server";
import { createDocumentShareToken, documentShareUrl } from "~/lib/document-share-token";
import { documentSharingFunctions } from "~/lib/document-sharing-functions";
import { createDocumentSharingHandlers } from "~/lib/document-sharing-handlers";

const siteUrl = process.env["SITE_URL"];

const handlers = createDocumentSharingHandlers({
  getAuthedClient: getAuthedConvexClient,
  createToken: createDocumentShareToken,
  shareUrl: (id, token) => {
    if (!siteUrl) throw new Error("The sharing origin is not configured");
    return documentShareUrl(siteUrl, id, token);
  },
  enable: (client, id, tokenHash) =>
    client.mutation(documentSharingFunctions.enable, { id: id as Id<"documents">, tokenHash }),
  disable: (client, id) =>
    client.mutation(documentSharingFunctions.disable, { id: id as Id<"documents"> }),
  errorResponse,
});

export const POST = handlers.POST;
export const DELETE = handlers.DELETE;
