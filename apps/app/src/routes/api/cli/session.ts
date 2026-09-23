import { getSessionCookie } from "better-auth/cookies";

import {
  api,
  errorResponse,
  getAuthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
};

export const GET = async ({ request }: { request: Request }) => {
  try {
    const { client, token } = await getAuthedConvexClient(request);

    if (!token || !(await client.query(api.auth.currentUser, {}))) {
      return Response.json(
        { error: "Authentication required" },
        { status: 401, headers: privateHeaders }
      );
    }

    const sessionToken = getSessionCookie(request.headers);

    if (!sessionToken) {
      return Response.json(
        { error: "Authentication required" },
        { status: 401, headers: privateHeaders }
      );
    }

    return Response.json({ token: sessionToken }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof Error && error.message === "Convex is not configured") {
      const response = missingServerConfigurationResponse();
      for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
      return response;
    }

    const response = errorResponse(error);
    for (const [name, value] of Object.entries(privateHeaders)) response.headers.set(name, value);
    return response;
  }
};
