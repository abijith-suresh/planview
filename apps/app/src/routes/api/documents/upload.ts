import { randomUUID } from "node:crypto";
import { UTApi, UTFile } from "uploadthing/server";

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
  uploadFile: async ({ file, customId }) => {
    const token = process.env["UPLOADTHING_TOKEN"];
    if (!token) {
      throw new Error("File storage is not configured yet.");
    }

    const result = await new UTApi({ token }).uploadFiles(
      new UTFile([new Uint8Array(await file.arrayBuffer())], file.name, {
        type: "text/html",
        customId,
      }),
      { acl: "public-read", contentDisposition: "inline" }
    );

    if (result.error || !result.data) {
      throw new Error(result.error?.message ?? "The HTML file could not be stored.");
    }
  },
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
  deleteStorageObject: (key) => getDocumentStorage("uploadthing").delete(key),
  createUploadId: randomUUID,
  missingServerConfigurationResponse,
  errorResponse,
});
