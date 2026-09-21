import type { Id } from "../../../../convex/_generated/dataModel";

import {
  api,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";

type CreateDocumentBody = {
  title?: unknown;
  storageId?: unknown;
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
  const storageId = typeof body.storageId === "string" ? body.storageId : "";
  const contentType = typeof body.contentType === "string" ? body.contentType : "";
  const sizeBytes = typeof body.sizeBytes === "number" ? body.sizeBytes : NaN;

  if (!title || !storageId || contentType !== "text/html" || !Number.isFinite(sizeBytes)) {
    return Response.json(
      { error: "A title, HTML storage id, content type, and size are required" },
      { status: 400 }
    );
  }

  try {
    const { client, token } = await getAuthedConvexClient(request);

    if (!token) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    const id = await client.mutation(api.documents.create, {
      title,
      storageId: storageId as Id<"_storage">,
      contentType,
      sizeBytes,
    });

    return Response.json({ id }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "Convex is not configured") {
      return missingServerConfigurationResponse();
    }

    return errorResponse(error);
  }
};
