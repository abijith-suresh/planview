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
  const headers = new Headers(request.headers);

  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("connection");
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  headers.set("host", new URL(convexSiteUrl).host);
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(/:$/, ""));
  headers.set("x-better-auth-forwarded-host", requestUrl.host);
  headers.set("x-better-auth-forwarded-proto", requestUrl.protocol.replace(/:$/, ""));

  headers.delete("accept-encoding");

  try {
    const response = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "github",
        callbackURL: new URL("/dashboard", requestUrl).toString(),
      }),
      redirect: "manual",
    });

    if (!response.ok) {
      console.error("Better Auth social sign-in returned an error", response.status);
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
