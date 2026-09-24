export type CliSessionHandlerDependencies<Client> = {
  getAuthedClient(request: Request): Promise<{
    client: Client;
    token: string | null | undefined;
  }>;
  getCurrentUser(client: Client): Promise<unknown>;
  getSessionToken(headers: Headers): string | null;
  missingServerConfigurationResponse(): Response;
  errorResponse(error: unknown): Response;
};

const privateHeaders = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
};

export function createCliSessionHandler<Client>(
  dependencies: CliSessionHandlerDependencies<Client>
) {
  return async ({ request }: { request: Request }) => {
    try {
      const { client, token } = await dependencies.getAuthedClient(request);

      if (!token || !(await dependencies.getCurrentUser(client))) {
        return Response.json(
          { error: "Authentication required" },
          { status: 401, headers: privateHeaders }
        );
      }

      const sessionToken = dependencies.getSessionToken(request.headers);

      if (!sessionToken) {
        return Response.json(
          { error: "Authentication required" },
          { status: 401, headers: privateHeaders }
        );
      }

      return Response.json({ token: sessionToken }, { headers: privateHeaders });
    } catch (error) {
      if (error instanceof Error && error.message === "Convex is not configured") {
        const response = dependencies.missingServerConfigurationResponse();
        for (const [name, value] of Object.entries(privateHeaders))
          response.headers.set(name, value);
        return response;
      }

      const response = dependencies.errorResponse(error);
      for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
      return response;
    }
  };
}
