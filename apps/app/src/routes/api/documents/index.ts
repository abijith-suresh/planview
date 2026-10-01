import {
  api,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";
import { createDocumentCollectionHandlers } from "~/lib/document-collection-handlers";

const handlers = createDocumentCollectionHandlers({
  getAuthedClient: getAuthedConvexClient,
  listDocuments: (client) => client.query(api.documents.list, {}),
  listDocumentPage: (client, paginationOpts) =>
    client.query(api.documents.listPage, { paginationOpts }),
  missingServerConfigurationResponse,
  errorResponse,
});

export const GET = handlers.GET;
