import assert from "node:assert/strict";
import { test } from "node:test";

import { mcp } from "@better-auth/mcp";
import { convex } from "@convex-dev/better-auth/plugins";
import { jwt } from "better-auth/plugins";
import type { AuthConfig } from "convex/server";

import { preserveConvexEndpoints } from "../convex/pluginEndpoints.ts";

test("Convex token and JWKS routes survive the JWT and MCP plugins", () => {
  const authConfig: AuthConfig = {
    providers: [
      {
        type: "customJwt",
        issuer: "https://auth.example",
        applicationID: "convex",
        algorithm: "RS256",
        jwks: "https://auth.example/api/auth/convex/jwks",
      },
    ],
  };
  const plugins = [
    preserveConvexEndpoints(convex({ authConfig })),
    jwt({ jwks: { keyPairConfig: { alg: "RS256" } } }),
    mcp({
      loginPage: "/mcp/login",
      consentPage: "/mcp/consent",
      resource: "https://app.example/mcp",
    }),
  ];

  const endpointKeys = plugins.flatMap((plugin) => Object.keys(plugin.endpoints ?? {}));
  assert.equal(new Set(endpointKeys).size, endpointKeys.length);

  const endpoints = Object.assign({}, ...plugins.map((plugin) => plugin.endpoints));
  assert.equal(endpoints.getConvexToken.path, "/convex/token");
  assert.equal(endpoints.getConvexJwks.path, "/convex/jwks");
  assert.equal(endpoints.getConvexOpenIdConfig.path, "/convex/.well-known/openid-configuration");
  assert.equal(endpoints.getToken.path, "/token");
  assert.equal(endpoints.getJwks.path, "/jwks");
});
