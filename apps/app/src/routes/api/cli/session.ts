import {
  api,
  errorResponse,
  getAuthedConvexClient,
  getUnauthedConvexClient,
  missingServerConfigurationResponse,
} from "~/lib/convex-server";
import { issueCliCredential } from "~/lib/cli-credential";
import { createCliRevocationHandler, createCliSessionHandler } from "~/lib/cli-session-handler";

export const POST = createCliSessionHandler({
  getAuthedClient: getAuthedConvexClient,
  getCurrentUser: (client) => client.query(api.auth.currentUser, {}),
  createCredential: issueCliCredential,
  issueCredential: (client, tokenHash) => client.mutation(api.cliCredentials.issue, { tokenHash }),
  missingServerConfigurationResponse,
  errorResponse,
});

export const DELETE = createCliRevocationHandler({
  getClient: getUnauthedConvexClient,
  revokeCredential: (client, tokenHash) =>
    client.mutation(api.cliCredentials.revoke, { tokenHash }),
  errorResponse,
});
