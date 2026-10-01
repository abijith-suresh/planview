import { randomUUID } from "node:crypto";

import {
  api,
  errorResponse,
  getAuthedConvexClient,
  getUnauthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";
import { cliCredentialFromRequest } from "~/lib/cli-credential";
import { getDocumentStorage, isDocumentStorageConfigured } from "~/lib/document-storage";
import { createDocumentUploadHandler } from "~/lib/document-upload-handler";
import { createDocumentProof } from "~/lib/document-mutation-proof";

export const POST = createDocumentUploadHandler({
  getAuthedClient: (request) => {
    const cliCredential = cliCredentialFromRequest(request);
    if (cliCredential) {
      return Promise.resolve({ client: getUnauthedConvexClient(), token: cliCredential.tokenHash });
    }
    return getAuthedConvexClient(request);
  },
  getCurrentUser: (client, request) => {
    const cliCredential = cliCredentialFromRequest(request);
    return cliCredential
      ? client.query(api.cliCredentials.lookup, cliCredential)
      : client.query(api.auth.currentUser, {});
  },
  isStorageConfigured: isDocumentStorageConfigured,
  uploadFile: (input) => getDocumentStorage().upload(input),
  createMetadata: async (client, input, ownerId, request) => {
    const proof = await createDocumentProof({ ownerId, ...input });
    const cliCredential = cliCredentialFromRequest(request);
    return cliCredential
      ? client.mutation(api.documents.createWithCliCredential, {
          ...input,
          ...cliCredential,
          proof,
        })
      : client.mutation(api.documents.create, { ...input, proof });
  },
  deleteStorageObject: ({ storageProvider, storageKey }) =>
    getDocumentStorage(storageProvider).delete(storageKey),
  createUploadId: randomUUID,
  missingServerConfigurationResponse,
  errorResponse,
});
