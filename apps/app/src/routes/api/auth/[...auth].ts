import { convexSiteUrl, proxyResponse } from "~/lib/convex-server";

type AuthEvent = { request: Request };

const unsupportedMethod = new Set(["GET", "HEAD"]);

async function proxyAuthRequest({ request }: AuthEvent) {
  const siteUrl = convexSiteUrl;

  if (!siteUrl) {
    return Response.json(
      {
        error: "Authentication is not configured yet.",
        code: "AUTH_NOT_CONFIGURED",
      },
      { status: 503 }
    );
  }

  const requestUrl = new URL(request.url);
  const upstreamUrl = `${siteUrl}${requestUrl.pathname}${requestUrl.search}`;
  const headers = new Headers(request.headers);

  headers.delete("transfer-encoding");
  headers.delete("content-length");
  headers.delete("connection");
  headers.set("accept-encoding", "application/json");
  headers.set("host", new URL(siteUrl).host);
  headers.set("x-forwarded-host", requestUrl.host);
  headers.set("x-forwarded-proto", requestUrl.protocol.replace(/:$/, ""));
  headers.set("x-better-auth-forwarded-host", requestUrl.host);
  headers.set("x-better-auth-forwarded-proto", requestUrl.protocol.replace(/:$/, ""));

  const response = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    redirect: "manual",
    body: unsupportedMethod.has(request.method) ? undefined : request.body,
    // @ts-expect-error Modern fetch requires duplex for streamed request bodies.
    duplex: "half",
  });

  return proxyResponse(response);
}

export const GET = proxyAuthRequest;
export const POST = proxyAuthRequest;
export const PATCH = proxyAuthRequest;
export const PUT = proxyAuthRequest;
export const DELETE = proxyAuthRequest;
