import { randomUUID } from "node:crypto";
import { UTApi, UTFile } from "uploadthing/server";

import {
  api,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";
import { getDocumentStorage } from "~/lib/document-storage";

const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_SIZE_BYTES = MAX_FILE_SIZE_BYTES + 64 * 1024;
const uploadThingToken = process.env.UPLOADTHING_TOKEN;

export const POST = async ({ request }: { request: Request }) => {
  const contentLength = Number(request.headers.get("content-length"));

  if (!Number.isSafeInteger(contentLength) || contentLength <= 0) {
    return Response.json({ error: "A bounded Content-Length header is required" }, { status: 411 });
  }
  if (contentLength > MAX_REQUEST_SIZE_BYTES) {
    return Response.json({ error: "The upload request exceeds the 8 MiB limit" }, { status: 413 });
  }

  try {
    const { client, token } = await getAuthedConvexClient(request);

    if (!token) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const identity = await client.query(api.auth.currentUser, {});
    if (!identity) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }
    if (!uploadThingToken) {
      return Response.json(
        { error: "File storage is not configured yet.", code: "STORAGE_NOT_CONFIGURED" },
        { status: 503 }
      );
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return Response.json({ error: "The upload form could not be read" }, { status: 400 });
    }

    const files = formData.getAll("file");
    const file = files[0];
    const titleField = formData.get("title");
    const title = typeof titleField === "string" ? titleField.trim() : "";

    if (
      files.length !== 1 ||
      !(file instanceof File) ||
      !file.name.toLowerCase().endsWith(".html") ||
      file.type !== "text/html" ||
      file.size > MAX_FILE_SIZE_BYTES ||
      title.length === 0 ||
      title.length > 200
    ) {
      return Response.json(
        { error: "Upload one .html file up to 8 MiB with a title of 1 to 200 characters" },
        { status: 400 }
      );
    }

    const customId = `${identity.subject}:${randomUUID()}`;
    const storageKey = `uploadthing-custom-id:${customId}`;
    const storage = getDocumentStorage("uploadthing");
    const uploadResult = await new UTApi({ token: uploadThingToken }).uploadFiles(
      new UTFile([new Uint8Array(await file.arrayBuffer())], file.name, {
        type: "text/html",
        customId,
      }),
      { acl: "public-read", contentDisposition: "inline" }
    );

    if (uploadResult.error || !uploadResult.data) {
      throw new Error(uploadResult.error?.message ?? "The HTML file could not be stored.");
    }

    let id: string;
    try {
      id = await client.mutation(api.documents.create, {
        title,
        storageProvider: "uploadthing",
        storageKey,
        contentType: "text/html",
        sizeBytes: file.size,
      });
    } catch (error) {
      await storage.delete(storageKey).catch(() => undefined);
      throw error;
    }

    return Response.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Convex is not configured") {
      return missingServerConfigurationResponse();
    }

    return errorResponse(error);
  }
};
