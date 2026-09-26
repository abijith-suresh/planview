type SocialSignInResponse = {
  url?: string;
};

type GitHubSignInDependencies = {
  convexSiteUrl: string | undefined;
  railwayPublicDomain: string | undefined;
  fetcher?: typeof fetch;
  logger?: Pick<Console, "error">;
};

export const startGitHubSignIn = async (
  request: Request,
  {
    convexSiteUrl,
    railwayPublicDomain,
    fetcher = fetch,
    logger = console,
  }: GitHubSignInDependencies
) => {
  if (!convexSiteUrl) {
    return Response.json(
      {
        error: "Authentication is not configured yet.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503 }
    );
  }

  const requestUrl = new URL(request.url);
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = request.headers.get("host");
  const isInternalHost = (host: string) => {
    const hostname = host.replace(/^\[([^\]]+)\](?::\d+)?$/, "$1").replace(/:\d+$/, "");
    return (
      hostname === "localhost" ||
      hostname === "::1" ||
      hostname.startsWith("127.") ||
      hostname.endsWith(".railway.internal")
    );
  };
  const appHost =
    (railwayPublicDomain &&
    (requestHost === railwayPublicDomain || forwardedHost === railwayPublicDomain)
      ? railwayPublicDomain
      : undefined) ??
    (requestHost && !isInternalHost(requestHost) ? requestHost : undefined) ??
    (forwardedHost && !isInternalHost(forwardedHost) ? forwardedHost : undefined) ??
    railwayPublicDomain ??
    requestHost ??
    requestUrl.host;
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const appProtocol =
    forwardedProtocol === "https" || forwardedProtocol === "http"
      ? forwardedProtocol
      : appHost === railwayPublicDomain
        ? "https"
        : requestUrl.protocol.replace(/:$/, "");
  const appUrl = new URL(`${appProtocol}://${appHost}`);
  const upstreamUrl = `${convexSiteUrl}/api/auth/sign-in/social`;
  const requestedReturnTo = requestUrl.searchParams.get("returnTo");
  let callbackURL = "/dashboard";

  if (requestedReturnTo) {
    const returnUrl = new URL(requestedReturnTo, appUrl.origin);

    if (returnUrl.origin !== appUrl.origin) {
      return Response.json(
        { error: "The sign-in return URL must stay within this app." },
        { status: 400 }
      );
    }

    callbackURL = `${returnUrl.pathname}${returnUrl.search}${returnUrl.hash}`;
  }

  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    origin: appUrl.origin,
    host: new URL(convexSiteUrl).host,
    "x-forwarded-host": appUrl.host,
    "x-forwarded-proto": appUrl.protocol.replace(/:$/, ""),
    "x-better-auth-forwarded-host": appUrl.host,
    "x-better-auth-forwarded-proto": appUrl.protocol.replace(/:$/, ""),
  });
  const cookie = request.headers.get("cookie");

  if (cookie) headers.set("cookie", cookie);

  try {
    const response = await fetcher(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "github",
        callbackURL,
        ...(requestUrl.searchParams.has("oauth_query")
          ? { oauth_query: requestUrl.searchParams.get("oauth_query") }
          : {}),
      }),
      redirect: "manual",
    });

    if (!response.ok) {
      logger.error(
        "Better Auth social sign-in returned an error",
        response.status,
        await response.text()
      );
      return Response.json(
        {
          error: "GitHub sign-in could not be started.",
          code: "AUTH_START_FAILED",
        },
        { status: 502 }
      );
    }

    const body = (await response.json()) as SocialSignInResponse;
    const location = response.headers.get("location") ?? body.url;

    if (!location) {
      return Response.json(
        {
          error: "GitHub sign-in did not return a redirect.",
          code: "AUTH_REDIRECT_MISSING",
        },
        { status: 502 }
      );
    }

    const redirectHeaders = new Headers({ Location: location });
    const setCookie = response.headers.get("set-cookie");

    if (setCookie) redirectHeaders.set("set-cookie", setCookie);

    return new Response(null, { status: 302, headers: redirectHeaders });
  } catch (error) {
    logger.error("Could not reach Better Auth for GitHub sign-in", error);
    return Response.json(
      {
        error: "GitHub sign-in could not be started.",
        code: "AUTH_START_FAILED",
      },
      { status: 502 }
    );
  }
};
