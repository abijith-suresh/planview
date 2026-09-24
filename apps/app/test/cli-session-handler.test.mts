import assert from "node:assert/strict";
import { test } from "node:test";

import { createCliSessionHandler } from "../src/lib/cli-session-handler.ts";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
};

function createHandler(overrides: Record<string, unknown> = {}) {
  const calls = { getCurrentUser: 0, getSessionToken: 0 };
  const handler = createCliSessionHandler({
    getAuthedClient: async () => ({ client: {}, token: "convex-token" }),
    getCurrentUser: async () => {
      calls.getCurrentUser += 1;
      return { subject: "owner" };
    },
    getSessionToken: () => {
      calls.getSessionToken += 1;
      return "better-auth-session-token";
    },
    missingServerConfigurationResponse: () =>
      Response.json({ error: "backend unavailable" }, { status: 503 }),
    errorResponse: (error) =>
      Response.json({ error: error instanceof Error ? error.message : "unknown" }, { status: 500 }),
    ...overrides,
  });

  return { calls, handler };
}

test("requires an authenticated Convex token and sends no token when absent", async () => {
  const { calls, handler } = createHandler({
    getAuthedClient: async () => ({ client: {}, token: null }),
  });

  const response = await handler({ request: new Request("http://localhost/api/cli/session") });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
  assert.equal(calls.getCurrentUser, 0);
  assert.equal(calls.getSessionToken, 0);
  assert.equal(response.headers.get("cache-control"), privateHeaders["Cache-Control"]);
  assert.equal(response.headers.get("pragma"), privateHeaders.Pragma);
});

test("returns the session token with private no-store headers", async () => {
  const { handler } = createHandler();

  const response = await handler({ request: new Request("http://localhost/api/cli/session") });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { token: "better-auth-session-token" });
  assert.equal(response.headers.get("cache-control"), privateHeaders["Cache-Control"]);
  assert.equal(response.headers.get("pragma"), privateHeaders.Pragma);
});

test("does not return a session token when the current user is missing", async () => {
  const { calls, handler } = createHandler({ getCurrentUser: async () => null });

  const response = await handler({ request: new Request("http://localhost/api/cli/session") });

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Authentication required" });
  assert.equal(calls.getSessionToken, 0);
  assert.equal(response.headers.get("cache-control"), privateHeaders["Cache-Control"]);
});

test("applies private no-store headers to configuration and general error responses", async () => {
  const configurationHandler = createHandler({
    getAuthedClient: async () => {
      throw new Error("Convex is not configured");
    },
  }).handler;
  const configurationResponse = await configurationHandler({
    request: new Request("http://localhost/api/cli/session"),
  });

  assert.equal(configurationResponse.status, 503);
  assert.equal(configurationResponse.headers.get("cache-control"), privateHeaders["Cache-Control"]);
  assert.equal(configurationResponse.headers.get("pragma"), privateHeaders.Pragma);

  const errorHandler = createHandler({
    getAuthedClient: async () => {
      throw new Error("upstream failed");
    },
  }).handler;
  const errorResponse = await errorHandler({
    request: new Request("http://localhost/api/cli/session"),
  });

  assert.equal(errorResponse.status, 500);
  assert.deepEqual(await errorResponse.json(), { error: "upstream failed" });
  assert.equal(errorResponse.headers.get("cache-control"), privateHeaders["Cache-Control"]);
  assert.equal(errorResponse.headers.get("pragma"), privateHeaders.Pragma);
});
