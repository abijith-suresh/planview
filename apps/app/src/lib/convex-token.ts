type TokenResponse = { token?: unknown };

export class ConvexTokenServiceError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Authentication service could not issue a document token");
    this.status = status;
  }
}

export async function fetchConvexToken(
  siteUrl: string,
  requestHeaders: Headers,
  fetcher: typeof fetch = fetch
): Promise<string | null> {
  const headers = new Headers(requestHeaders);
  headers.set("host", new URL(siteUrl).host);
  headers.set("accept", "application/json");

  const response = await fetcher(`${siteUrl}/api/auth/convex/token`, {
    headers,
    redirect: "manual",
  });

  if (response.status === 401) return null;
  if (!response.ok) {
    console.error("auth.convex_token_failed", { status: response.status });
    throw new ConvexTokenServiceError(response.status);
  }

  let body: TokenResponse;
  try {
    body = (await response.json()) as TokenResponse;
  } catch {
    console.error("auth.convex_token_invalid", { status: response.status });
    throw new ConvexTokenServiceError(response.status);
  }
  if (typeof body.token !== "string" || !body.token) {
    console.error("auth.convex_token_missing", { status: response.status });
    throw new ConvexTokenServiceError(response.status);
  }
  return body.token;
}
