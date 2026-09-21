import type { Id } from "../../../../convex/_generated/dataModel";

import {
  api,
  convexSiteUrl,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
  proxyResponse,
} from "~/lib/convex-server";

type DocumentEvent = { request: Request; params: { id: string } };

export const GET = async ({ request, params }: DocumentEvent) => {
  try {
    const { token } = await getAuthedConvexClient(request);
    const siteUrl = convexSiteUrl;

    if (!token) {
      return new Response("Authentication required", { status: 401 });
    }

    if (!siteUrl) {
      return missingServerConfigurationResponse();
    }

    const response = await fetch(
      `${siteUrl}/documents/content?id=${encodeURIComponent(params.id)}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    return proxyResponse(response);
  } catch (error) {
    if (error instanceof Error && error.message === "Convex is not configured") {
      return missingServerConfigurationResponse();
    }

    return errorResponse(error);
  }
};

export const DELETE = async ({ request, params }: DocumentEvent) => {
  try {
    const { client, token } = await getAuthedConvexClient(request);

    if (!token) {
      return Response.json({ error: "Authentication required" }, { status: 401 });
    }

    await client.mutation(api.documents.remove, { id: params.id as Id<"documents"> });

    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === "Convex is not configured") {
      return missingServerConfigurationResponse();
    }

    return errorResponse(error);
  }
};
