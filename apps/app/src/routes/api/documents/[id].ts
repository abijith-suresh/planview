import type { Id } from "../../../../convex/_generated/dataModel";

import {
  api,
  convexSiteUrl,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
  proxyResponse,
} from "~/lib/convex-server";
import { createBundleCapability, bundleEntryUrl } from "~/lib/bundle-capability";
import { requireMutationSecret } from "~/lib/document-mutation-proof";
import { bundleResponseHeaders } from "~/lib/bundle-asset-handler";
import { getDocumentStorage } from "~/lib/document-storage";
import {
  createDocumentDeleteHandler,
  createDocumentPreviewHandler,
  type DocumentAccessHandlerDependencies,
} from "~/lib/document-access-handlers";

type ConvexClient = Awaited<ReturnType<typeof getAuthedConvexClient>>["client"];

const dependencies: DocumentAccessHandlerDependencies<ConvexClient> = {
  getAuthedClient: getAuthedConvexClient,
  getDocument: (client, id) => client.query(api.documents.get, { id: id as Id<"documents"> }),
  bundlePreview: async (id, document) => {
    if (!document.ownerId || !document.storageProvider || !document.storageKey)
      throw new Error("Invalid bundle metadata");
    const siteUrl = process.env["SITE_URL"];
    if (!siteUrl) throw new Error("Bundle preview origin is not configured");
    const cap = createBundleCapability(requireMutationSecret(), {
      documentId: id,
      ownerId: document.ownerId,
      storageProvider: document.storageProvider,
      storageKey: document.storageKey,
    });
    return new Response(null, {
      status: 302,
      headers: { ...bundleResponseHeaders, Location: bundleEntryUrl(siteUrl, id, cap) },
    });
  },
  getDocumentStorage,
  fetch: (input, init) => fetch(input, init),
  convexSiteUrl,
  proxyResponse,
  requestDeletion: (client, id) =>
    client.mutation(api.documents.requestDeletion, { id: id as Id<"documents"> }),
  missingServerConfigurationResponse,
  errorResponse,
};

export const GET = createDocumentPreviewHandler(dependencies);
export const DELETE = createDocumentDeleteHandler(dependencies);
