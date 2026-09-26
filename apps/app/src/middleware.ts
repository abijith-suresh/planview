import { createMiddleware } from "@solidjs/start/middleware";

import { authorizationServerMetadata, protectedResourceMetadata } from "./lib/mcp-discovery";

// SolidStart's route glob skips dot-prefixed directories. OAuth clients need
// these exact /.well-known paths, so serve them before filesystem routing.
export default createMiddleware([
  (event, next) => {
    const path = new URL(event.req.url).pathname;
    if (event.req.method === "GET") {
      if (
        path === "/.well-known/oauth-protected-resource" ||
        path === "/.well-known/oauth-protected-resource/mcp"
      ) {
        return protectedResourceMetadata();
      }
      if (
        path === "/.well-known/oauth-authorization-server" ||
        path === "/.well-known/oauth-authorization-server/api/auth"
      ) {
        return authorizationServerMetadata();
      }
    }
    return next();
  },
]);
