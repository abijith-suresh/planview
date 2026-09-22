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

type DocumentEvent = { request: Request; params: { id: string } };

const previewContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "sandbox allow-scripts allow-modals allow-popups",
  "script-src 'unsafe-inline' https: blob:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: blob: https:",
  "media-src data: blob: https:",
  "connect-src https:",
  "worker-src blob: https:",
  "frame-src https:",
].join("; ");

const previewResponse = async (response: Response, contentType: string) => {
  if (!response.ok) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(await response.arrayBuffer(), {
    headers: {
      "Cache-Control": "private, no-store",
      "Content-Disposition": "inline",
      "Content-Security-Policy": previewContentSecurityPolicy,
      "Content-Type": `${contentType}; charset=utf-8`,
      "Permissions-Policy": "camera=(), geolocation=(), microphone=(), payment=()",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
};

export const GET = async ({ request, params }: DocumentEvent) => {
  try {
    const { client, token } = await getAuthedConvexClient(request);
    const siteUrl = convexSiteUrl;

    if (!token) {
      return new Response("Authentication required", { status: 401 });
    }

    const document = await client.query(api.documents.get, {
      id: params.id as Id<"documents">,
    });

    if (!document) {
      return new Response("Not found", { status: 404 });
    }

    if (document.storageProvider && document.storageKey) {
      const storage = getDocumentStorage(document.storageProvider);
      const response = await fetch(await storage.getReadUrl(document.storageKey));
      return previewResponse(response, document.contentType);
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

    const id = params.id as Id<"documents">;
    const document = await client.query(api.documents.get, { id });

    if (!document) {
      return Response.json({ error: "Document not found" }, { status: 404 });
    }

    if (document.storageProvider && document.storageKey) {
      const storage = getDocumentStorage(document.storageProvider);
      await storage.delete(document.storageKey);
      await client.mutation(api.documents.removeMetadata, { id });
    } else {
      await client.mutation(api.documents.remove, { id });
    }

    return new Response(null, { status: 204 });
  } catch (error) {
    if (error instanceof Error && error.message === "Convex is not configured") {
      return missingServerConfigurationResponse();
    }

    return errorResponse(error);
  }
};
