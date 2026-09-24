import { getSessionCookie } from "better-auth/cookies";

import {
  api,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";
import { createCliSessionHandler } from "~/lib/cli-session-handler";

export const GET = createCliSessionHandler({
  getAuthedClient: getAuthedConvexClient,
  getCurrentUser: (client) => client.query(api.auth.currentUser, {}),
  getSessionToken: (headers) => getSessionCookie(headers) ?? null,
  missingServerConfigurationResponse,
  errorResponse,
});
