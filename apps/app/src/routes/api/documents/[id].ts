import type { Id } from "../../../../convex/_generated/dataModel";

import {
  api,
  convexSiteUrl,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
  proxyResponse,
} from "~/lib/convex-server";
import { getDocumentStorage } from "~/lib/document-storage";
import { removeDocumentProof } from "~/lib/document-mutation-proof";
import {
  createDocumentDeleteHandler,
  createDocumentPreviewHandler,
  type DocumentAccessHandlerDependencies,
} from "~/lib/document-access-handlers";

type ConvexClient = Awaited<ReturnType<typeof getAuthedConvexClient>>["client"];

const dependencies: DocumentAccessHandlerDependencies<ConvexClient> = {
  getAuthedClient: getAuthedConvexClient,
  getDocument: (client, id) => client.query(api.documents.get, { id: id as Id<"documents"> }),
  getDocumentStorage,
  fetch: (input, init) => fetch(input, init),
  convexSiteUrl,
  proxyResponse,
  removeDocument: (client, id) =>
    client.mutation(api.documents.remove, { id: id as Id<"documents"> }),
  removeDocumentMetadata: async (client, id) => {
    const identity = await client.query(api.auth.currentUser, {});
    if (!identity) throw new Error("Authentication required");
    return client.mutation(api.documents.removeMetadata, {
      id: id as Id<"documents">,
      proof: await removeDocumentProof(identity.subject, id),
    });
  },
  missingServerConfigurationResponse,
  errorResponse,
};

export const GET = createDocumentPreviewHandler(dependencies);
export const DELETE = createDocumentDeleteHandler(dependencies);
