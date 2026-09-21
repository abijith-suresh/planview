import { convexSiteUrl } from "~/lib/convex-server";

type SocialSignInResponse = {
  url?: string;
};

export const GET = async ({ request }: { request: Request }) => {
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
  const upstreamUrl = `${convexSiteUrl}/api/auth/sign-in/social`;
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
    origin: requestUrl.origin,
    host: new URL(convexSiteUrl).host,
    "x-forwarded-host": requestUrl.host,
    "x-forwarded-proto": requestUrl.protocol.replace(/:$/, ""),
    "x-better-auth-forwarded-host": requestUrl.host,
    "x-better-auth-forwarded-proto": requestUrl.protocol.replace(/:$/, ""),
  });
  const cookie = request.headers.get("cookie");

  if (cookie) headers.set("cookie", cookie);

  try {
    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "github",
        callbackURL: "/dashboard",
      }),
      redirect: "manual",
    });

    if (!response.ok) {
      console.error(
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
    console.error("Could not reach Better Auth for GitHub sign-in", error);
    return Response.json(
      {
        error: "GitHub sign-in could not be started.",
        code: "AUTH_START_FAILED",
      },
      { status: 502 }
    );
  }
};
