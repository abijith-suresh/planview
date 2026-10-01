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
  requestDeletion: (client, id) =>
    client.mutation(api.documents.requestDeletion, { id: id as Id<"documents"> }),
  missingServerConfigurationResponse,
  errorResponse,
};

export const GET = createDocumentPreviewHandler(dependencies);
export const DELETE = createDocumentDeleteHandler(dependencies);
