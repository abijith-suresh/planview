import { getToken } from "@convex-dev/better-auth/utils";
import { ConvexHttpClient } from "convex/browser";

import { api } from "../../convex/_generated/api";

const convexUrl = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
export const convexSiteUrl = process.env.CONVEX_SITE_URL ?? process.env.VITE_CONVEX_SITE_URL;

export { api };

export async function getAuthedConvexClient(request: Request) {
  if (!convexUrl || !convexSiteUrl) {
    throw new Error("Convex is not configured");
  }

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("accept-encoding", "identity");

  const { token } = await getToken(convexSiteUrl, headers);
  const client = new ConvexHttpClient(convexUrl);

  if (token) {
    client.setAuth(token);
  }

  return { client, token };
}

export async function proxyResponse(response: Response) {
  const headers = new Headers(response.headers);

  headers.delete("content-length");
  // Fetch transparently decompresses upstream responses, so forwarding this
  // header would make the downstream client try to decompress plain bytes.
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");

  return new Response(await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function missingServerConfigurationResponse() {
  return Response.json(
    {
      error: "The cloud backend is not configured yet.",
      code: "BACKEND_NOT_CONFIGURED",
    },
    { status: 503 }
  );
}

export function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Unexpected server error";

  return Response.json({ error: message }, { status: 500 });
}
