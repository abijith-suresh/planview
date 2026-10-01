type RouteEvent = { request: Request; params: { id: string } };

const headers = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};

const json = (body: unknown, status = 200) => Response.json(body, { status, headers });

const isSameOriginRequest = (request: Request) => {
  const origin = request.headers.get("origin");
  return (
    request.headers.get("sec-fetch-site") !== "cross-site" &&
    (!origin || origin === new URL(request.url).origin)
  );
};

export function createDocumentSharingHandlers<Client>(dependencies: {
  getAuthedClient(request: Request): Promise<{ client: Client; token: string | null | undefined }>;
  createToken(): Promise<{ token: string; tokenHash: string }>;
  shareUrl(id: string, token: string): string;
  enable(client: Client, id: string, tokenHash: string): Promise<boolean>;
  disable(client: Client, id: string): Promise<boolean>;
  errorResponse(error: unknown): Response;
}) {
  return {
    async POST({ request, params }: RouteEvent) {
      if (!isSameOriginRequest(request)) return json({ error: "Forbidden" }, 403);
      try {
        const { client, token } = await dependencies.getAuthedClient(request);
        if (!token) return json({ error: "Authentication required" }, 401);
        const issued = await dependencies.createToken();
        const url = dependencies.shareUrl(params.id, issued.token);
        if (!(await dependencies.enable(client, params.id, issued.tokenHash))) {
          return json({ error: "Document not found" }, 404);
        }
        return json({ enabled: true, url });
      } catch (error) {
        return dependencies.errorResponse(error);
      }
    },
    async DELETE({ request, params }: RouteEvent) {
      if (!isSameOriginRequest(request)) return json({ error: "Forbidden" }, 403);
      try {
        const { client, token } = await dependencies.getAuthedClient(request);
        if (!token) return json({ error: "Authentication required" }, 401);
        if (!(await dependencies.disable(client, params.id)))
          return json({ error: "Document not found" }, 404);
        return new Response(null, { status: 204, headers });
      } catch (error) {
        return dependencies.errorResponse(error);
      }
    },
  };
}

export function createSharedDocumentPreviewHandler<Document>(dependencies: {
  resolve(id: string, token: string): Promise<Document | null>;
  preview(document: Document): Promise<Response>;
}) {
  return async ({ params }: { params: { id: string; token: string } }) => {
    const notFound = () => new Response("Not found", { status: 404, headers });
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.token)) return notFound();
    try {
      const document = await dependencies.resolve(params.id, params.token);
      if (!document) return notFound();
      const response = await dependencies.preview(document);
      const responseHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(headers)) responseHeaders.set(key, value);
      return new Response(response.body, { status: response.status, headers: responseHeaders });
    } catch {
      // Never expose document existence, storage locators, or provider errors.
      return notFound();
    }
  };
}
