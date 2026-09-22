import {
  api,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";
import { getDocumentStorage, isDocumentStorageConfigured } from "~/lib/document-storage";

type CreateDocumentBody = {
  title?: unknown;
  storageProvider?: unknown;
  uploadOwnerId?: unknown;
  uploadCustomId?: unknown;
  contentType?: unknown;
  sizeBytes?: unknown;
};

export const GET = async ({ request }: { request: Request }) => {
  try {
    const { client, token } = await getAuthedConvexClient(request);

    if (!token) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    return Response.json(await client.query(api.documents.list, {}));
  } catch (error) {
    if (error instanceof Error && error.message === "Convex is not configured") {
      return missingServerConfigurationResponse();
    }

    return errorResponse(error);
  }
};

export const POST = async ({ request }: { request: Request }) => {
  let body: CreateDocumentBody;

  try {
    body = (await request.json()) as CreateDocumentBody;
  } catch {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const storageProvider = typeof body.storageProvider === "string" ? body.storageProvider : "";
  const uploadOwnerId = typeof body.uploadOwnerId === "string" ? body.uploadOwnerId : "";
  const uploadCustomId = typeof body.uploadCustomId === "string" ? body.uploadCustomId : "";
  const storageKey = `uploadthing-custom-id:${uploadCustomId}`;
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : NaN;

  if (
    !title ||
    storageProvider !== "uploadthing" ||
    !uploadOwnerId ||
    !uploadCustomId ||
    contentType !== "text/html" ||
    !Number.isFinite(sizeBytes) ||
    sizeBytes < 0
  ) {
    return Response.json(
      { error: "A title, uploaded HTML file, content type, and size are required" },
      { status: 400 }
    );
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

    if (uploadOwnerId !== identity.subject || !uploadCustomId.startsWith(`${identity.subject}:`)) {
      return Response.json(
        { error: "The uploaded file does not belong to this account" },
        { status: 403 }
      );
    }

    if (!isDocumentStorageConfigured()) {
      return Response.json(
        {
          error: "File storage is not configured yet.",
          code: "STORAGE_NOT_CONFIGURED",
        },
        { status: 503 }
      );
    }

    const storage = getDocumentStorage(storageProvider);

    let id: string;

    try {
      id = await client.mutation(api.documents.create, {
        title,
        storageProvider,
        storageKey,
        contentType,
        sizeBytes,
      });
    } catch (error) {
      // Avoid leaving an object behind when metadata creation fails. A later
      // cleanup job can handle uploads abandoned before this request arrives.
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
