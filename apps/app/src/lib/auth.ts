import { convexClient } from "@convex-dev/better-auth/client/plugins";
import { createAuthClient } from "better-auth/solid";

export const authClient = createAuthClient({
  plugins: [convexClient()],
});
