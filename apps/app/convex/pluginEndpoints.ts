import type { convex } from "@convex-dev/better-auth/plugins";

// Better Auth indexes plugin endpoints by object key, not URL path. The
// standalone JWT and OAuth plugins reuse these keys for different routes.
export function preserveConvexEndpoints(plugin: ReturnType<typeof convex>) {
  const {
    getOpenIdConfig: getConvexOpenIdConfig,
    getJwks: getConvexJwks,
    getToken: getConvexToken,
    ...otherEndpoints
  } = plugin.endpoints;

  return {
    ...plugin,
    endpoints: {
      ...otherEndpoints,
      getConvexOpenIdConfig,
      getConvexJwks,
      getConvexToken,
    },
  };
}
