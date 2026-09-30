const observedPaths = new Set([
  "/auth/github",
  "/api/auth/callback/github",
  "/api/auth/convex/token",
  "/api/auth/get-session",
  "/api/auth/oauth2/authorize",
  "/api/auth/oauth2/consent",
]);

export async function logAuthResponse(request: Request, response: Response) {
  if (process.env["AUTH_DIAGNOSTICS"] !== "true") return;

  const path = new URL(request.url).pathname;
  if (!observedPaths.has(path) && response.status < 400) return;

  const setCookies = response.headers.getSetCookie();
  const cookieNames = setCookies.map((cookie) => cookie.split("=", 1)[0]);
  let redirect: string | undefined;
  const location = response.headers.get("location");
  if (location) {
    try {
      const url = new URL(location, request.url);
      redirect = `${url.origin}${url.pathname}`;
    } catch {
      redirect = "invalid";
    }
  }

  let sessionPresent: boolean | undefined;
  if (path === "/api/auth/get-session" && response.ok) {
    try {
      const body = (await response.clone().json()) as unknown;
      sessionPresent =
        typeof body === "object" && body !== null && "session" in body && Boolean(body.session);
    } catch {
      sessionPresent = undefined;
    }
  }

  console.info(
    "auth.response",
    JSON.stringify({
      method: request.method,
      path,
      status: response.status,
      requestHasSessionCookie: /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(
        request.headers.get("cookie") ?? ""
      ),
      setCookieNames: cookieNames,
      sessionPresent,
      redirect,
    })
  );
}
