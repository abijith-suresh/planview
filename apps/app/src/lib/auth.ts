import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/solid";

export const authClient = createAuthClient({
  plugins: [convexClient()],
});

export const authPreview = {
  provider: "GitHub",
  status: "wired" as const,
  description: "The auth boundary is wired; GitHub OAuth credentials are still required.",
};
