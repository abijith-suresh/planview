import { randomUUID } from "node:crypto";
import { UTApi, UTFile } from "uploadthing/server";

import {
  api,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";
import { getDocumentStorage, isDocumentStorageConfigured } from "~/lib/document-storage";
import { createDocumentUploadHandler } from "~/lib/document-upload-handler";
import { createDocumentProof } from "~/lib/document-mutation-proof";

export const POST = createDocumentUploadHandler({
  getAuthedClient: getAuthedConvexClient,
  getCurrentUser: (client) => client.query(api.auth.currentUser, {}),
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
  createMetadata: async (client, input, ownerId) =>
    client.mutation(api.documents.create, {
      ...input,
      proof: await createDocumentProof({ ownerId, ...input }),
    }),
  deleteStorageObject: (key) => getDocumentStorage("uploadthing").delete(key),
  createUploadId: randomUUID,
  missingServerConfigurationResponse,
  errorResponse,
});
