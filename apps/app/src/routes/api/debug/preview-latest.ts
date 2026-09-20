import { convexSiteUrl, missingServerConfigurationResponse } from "~/lib/convex-server";

// Temporary staging diagnostic. The Convex action is gated by
// DEBUG_PUBLIC_PREVIEW and returns the latest stored document without auth.
export const GET = async () => {
  if (!convexSiteUrl) {
    return missingServerConfigurationResponse();
  }

  const response = await fetch(`${convexSiteUrl}/debug/preview-latest`);
  const headers = new Headers(response.headers);

  headers.delete("content-length");
  headers.delete("transfer-encoding");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};
