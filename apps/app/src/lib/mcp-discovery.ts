import { convexSiteUrl, proxyResponse } from "./convex-server";

const siteUrl = process.env["SITE_URL"]?.replace(/\/$/, "");

export const protectedResourceMetadata = () => {
  if (!siteUrl) return new Response(null, { status: 503 });
  return Response.json(
    {
      resource: `${siteUrl}/mcp`,
      authorization_servers: [`${siteUrl}/api/auth`],
      bearer_methods_supported: ["header"],
      scopes_supported: ["cloud:documents"],
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
};

export const authorizationServerMetadata = async () => {
  if (!convexSiteUrl || !siteUrl) return new Response(null, { status: 503 });
  const response = await fetch(`${convexSiteUrl}/api/auth/.well-known/oauth-authorization-server`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  return proxyResponse(response);
};
