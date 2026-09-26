import {
  api,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";
import { createDocumentCollectionHandlers } from "~/lib/document-collection-handlers";
import { getDocumentStorage, isDocumentStorageConfigured } from "~/lib/document-storage";

const handlers = createDocumentCollectionHandlers({
  getAuthedClient: getAuthedConvexClient,
  getCurrentUser: (client) => client.query(api.auth.currentUser, {}),
  listDocuments: (client) => client.query(api.documents.list, {}),
  listDocumentPage: (client, paginationOpts) =>
    client.query(api.documents.listPage, { paginationOpts }),
  isStorageConfigured: isDocumentStorageConfigured,
  createMetadata: (client, input) => client.mutation(api.documents.create, input),
  deleteStorageObject: (key) => getDocumentStorage("uploadthing").delete(key),
  missingServerConfigurationResponse,
  errorResponse,
});

export const GET = handlers.GET;
export const POST = handlers.POST;
