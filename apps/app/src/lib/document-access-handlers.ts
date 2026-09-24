import type { DocumentStorageAdapter } from "./document-storage.js";

export type DocumentAccessRecord = Readonly<{
  readonly contentType: string;
  readonly storageProvider?: string;
  readonly storageKey?: string;
}>;

export type DocumentAccessHandlerDependencies<Client> = {
  getAuthedClient(request: Request): Promise<{
    client: Client;
    token: string | null | undefined;
  }>;
  getDocument(client: Client, id: string): Promise<DocumentAccessRecord | null | undefined>;
  getDocumentStorage(provider: string): DocumentStorageAdapter;
  fetch(input: string, init?: RequestInit): Promise<Response>;
  readonly convexSiteUrl: string | undefined;
  proxyResponse(response: Response): Promise<Response>;
  removeDocument(client: Client, id: string): Promise<unknown>;
  removeDocumentMetadata(client: Client, id: string): Promise<unknown>;
  missingServerConfigurationResponse(): Response;
  errorResponse(error: unknown): Response;
};

export type DocumentRouteEvent = { request: Request; params: { id: string } };

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

const errorResponse = <Client>(
  dependencies: DocumentAccessHandlerDependencies<Client>,
  error: unknown
) =>
  error instanceof Error && error.message === "Convex is not configured"
    ? dependencies.missingServerConfigurationResponse()
    : dependencies.errorResponse(error);

export function createDocumentPreviewHandler<Client>(
  dependencies: DocumentAccessHandlerDependencies<Client>
) {
  return async ({ request, params }: DocumentRouteEvent) => {
    try {
      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token) {
        return new Response("Authentication required", { status: 401 });
      }

      const document = await dependencies.getDocument(client, params.id);

      if (!document) {
        return new Response("Not found", { status: 404 });
      }

      if (document.storageProvider && document.storageKey) {
        const storage = dependencies.getDocumentStorage(document.storageProvider);
        const response = await dependencies.fetch(await storage.getReadUrl(document.storageKey));
        return previewResponse(response, document.contentType);
      }

      if (!dependencies.convexSiteUrl) {
        return dependencies.missingServerConfigurationResponse();
      }

      const response = await dependencies.fetch(
        `${dependencies.convexSiteUrl}/documents/content?id=${encodeURIComponent(params.id)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
        }
      );
      return dependencies.proxyResponse(response);
    } catch (error) {
      return errorResponse(dependencies, error);
    }
  };
}

export function createDocumentDeleteHandler<Client>(
  dependencies: DocumentAccessHandlerDependencies<Client>
) {
  return async ({ request, params }: DocumentRouteEvent) => {
    try {
      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token) {
        return Response.json({ error: "Authentication required" }, { status: 401 });
      }

      const document = await dependencies.getDocument(client, params.id);

      if (!document) {
        return Response.json({ error: "Document not found" }, { status: 404 });
      }

      if (document.storageProvider && document.storageKey) {
        const storage = dependencies.getDocumentStorage(document.storageProvider);
        await storage.delete(document.storageKey);
        await dependencies.removeDocumentMetadata(client, params.id);
      } else {
        await dependencies.removeDocument(client, params.id);
      }

      return new Response(null, { status: 204 });
    } catch (error) {
      return errorResponse(dependencies, error);
    }
  };
}
