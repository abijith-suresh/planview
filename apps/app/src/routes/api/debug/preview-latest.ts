import {
  convexSiteUrl,
  missingServerConfigurationResponse,
  proxyResponse,
} from "~/lib/convex-server";

// Temporary staging diagnostic. The Convex action is gated by
// DEBUG_PUBLIC_PREVIEW and returns the latest stored document without auth.
export const GET = async () => {
  if (!convexSiteUrl) {
    return missingServerConfigurationResponse();
  }

  const response = await fetch(`${convexSiteUrl}/debug/preview-latest`);

  return proxyResponse(response);
};
